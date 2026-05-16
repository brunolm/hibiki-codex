# Captures audio from a specific Windows process via the
# AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK activation flow. Requires
# Windows 10 2004 / build 19041+. Writes raw 16-bit mono PCM @ 16 kHz to
# stdout, same format as wasapi-loopback.ps1, so the rest of the pipeline
# doesn't need to care which capture script produced the bytes.
#
#   -ProcessId 1234                   target PID (must own an audio session)
#   -Mode include   (default)         capture target + descendants
#   -Mode exclude                     capture everything *except* the tree

param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [ValidateSet('include','exclude')][string]$Mode = 'include'
)

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace WasapiProcess {
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    public struct WAVEFORMATEX {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint   nSamplesPerSec;
        public uint   nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    public enum ActivationType {
        Default = 0,
        ProcessLoopback = 1
    }
    public enum LoopbackMode {
        IncludeTargetTree = 0,
        ExcludeTargetTree = 1
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessLoopbackParams {
        public uint TargetProcessId;
        public LoopbackMode ProcessLoopbackMode;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ActivationParams {
        public ActivationType Type;
        public ProcessLoopbackParams Loopback;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags,
                                     long hnsBufferDuration, long hnsPeriodicity,
                                     IntPtr pFormat, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr ppFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([In] ref Guid riid,
                                     [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr pData, out uint frames, out uint flags,
                                    out long devPos, out long qpcPos);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation {
        [PreserveSig] int GetActivateResult(out int activateResult,
                                            [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
    }

    [ComVisible(true), Guid("D0F2F8B7-1A02-4C77-9D8C-3F8B6A0E1A8E"),
     ClassInterface(ClassInterfaceType.None)]
    public class CompletionHandler : IActivateAudioInterfaceCompletionHandler {
        public ManualResetEvent Done = new ManualResetEvent(false);
        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
            Done.Set();
            return 0;
        }
    }

    public static class Capture {
        const int  CLSCTX_ALL = 23;
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK             = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM       = 0x80000000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY  = 0x08000000;
        const int  AUDCLNT_SHAREMODE_SHARED = 0;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const ushort VT_BLOB = 65;

        static readonly Guid IID_IAudioClient        = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        // Virtual device moniker for process-loopback activation. The exact
        // string is documented in the Windows SDK header (audioclientactivationparams.h).
        const string ProcessLoopbackDevice = "VAD\\Process_Loopback";

        [DllImport("mmdevapi.dll", CallingConvention = CallingConvention.StdCall, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [In] ref Guid iid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation operation);

        static void Check(int hr, string what) {
            if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
        }

        public static void Run(uint processId, bool includeTree) {
            // Build AUDIOCLIENT_ACTIVATION_PARAMS on the unmanaged heap so we
            // can hand its pointer to the PROPVARIANT below.
            var ap = new ActivationParams();
            ap.Type = ActivationType.ProcessLoopback;
            ap.Loopback.TargetProcessId = processId;
            ap.Loopback.ProcessLoopbackMode = includeTree
                ? LoopbackMode.IncludeTargetTree
                : LoopbackMode.ExcludeTargetTree;
            int apSize = Marshal.SizeOf(typeof(ActivationParams));
            IntPtr pAp = Marshal.AllocHGlobal(apSize);
            Marshal.StructureToPtr(ap, pAp, false);

            // PROPVARIANT is 24 bytes on x64. We only need VT_BLOB, which puts
            // cbSize at offset 8 and pBlobData at offset 16.
            IntPtr pv = Marshal.AllocHGlobal(24);
            for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
            Marshal.WriteInt16(pv, 0, (short)VT_BLOB);
            Marshal.WriteInt32(pv, 8, apSize);
            Marshal.WriteIntPtr(pv, 16, pAp);

            var handler = new CompletionHandler();
            Guid iidAudioClient = IID_IAudioClient;
            IActivateAudioInterfaceAsyncOperation asyncOp;
            ActivateAudioInterfaceAsync(ProcessLoopbackDevice, ref iidAudioClient,
                                        pv, handler, out asyncOp);
            handler.Done.WaitOne();
            Marshal.FreeHGlobal(pv);
            Marshal.FreeHGlobal(pAp);

            int activateHr;
            object iface;
            Check(asyncOp.GetActivateResult(out activateHr, out iface),
                  "GetActivateResult call");
            Check(activateHr, "ActivateAudioInterfaceAsync result");
            var audioClient = (IAudioClient)iface;

            var fmt = new WAVEFORMATEX {
                wFormatTag      = 1,
                nChannels       = 1,
                nSamplesPerSec  = 16000,
                wBitsPerSample  = 16,
                nBlockAlign     = 2,
                nAvgBytesPerSec = 32000,
                cbSize          = 0
            };
            IntPtr pFmt = Marshal.AllocHGlobal(Marshal.SizeOf(fmt));
            Marshal.StructureToPtr(fmt, pFmt, false);

            uint flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                       | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                       | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            Check(audioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, flags,
                                         2_000_000L, 0, pFmt, IntPtr.Zero),
                  "IAudioClient::Initialize");

            object captureObj;
            Guid clsidCapture = IID_IAudioCaptureClient;
            Check(audioClient.GetService(ref clsidCapture, out captureObj),
                  "GetService(IAudioCaptureClient)");
            var capture = (IAudioCaptureClient)captureObj;

            Check(audioClient.Start(), "IAudioClient::Start");

            var stdout = Console.OpenStandardOutput();
            byte[] buffer = new byte[65536];

            try {
                while (true) {
                    Thread.Sleep(50);
                    uint packetSize;
                    if (capture.GetNextPacketSize(out packetSize) != 0) break;
                    while (packetSize > 0) {
                        IntPtr pData;
                        uint frames, bufFlags;
                        long devPos, qpcPos;
                        if (capture.GetBuffer(out pData, out frames, out bufFlags,
                                              out devPos, out qpcPos) != 0) break;
                        int byteCount = (int)frames * 2;
                        if (byteCount > buffer.Length) buffer = new byte[byteCount];
                        if ((bufFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                            Array.Clear(buffer, 0, byteCount);
                        } else {
                            Marshal.Copy(pData, buffer, 0, byteCount);
                        }
                        stdout.Write(buffer, 0, byteCount);
                        stdout.Flush();
                        capture.ReleaseBuffer(frames);
                        if (capture.GetNextPacketSize(out packetSize) != 0) break;
                    }
                }
            } finally {
                audioClient.Stop();
                Marshal.FreeHGlobal(pFmt);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp
[WasapiProcess.Capture]::Run([uint32]$ProcessId, ($Mode -eq 'include'))

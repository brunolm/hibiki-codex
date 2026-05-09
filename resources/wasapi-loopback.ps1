# Captures WASAPI loopback from the current default playback device.
# Outputs raw 16-bit mono PCM @ 16 kHz to stdout (via WASAPI's built-in
# AUTOCONVERTPCM resampler). No external dependencies.

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace WasapiLoopback {
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

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig] int Activate([In] ref Guid iid, uint clsCtx, IntPtr actParams,
                                   [MarshalAs(UnmanagedType.IUnknown)] out object iface);
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

    public static class Loopback {
        const int  eRender = 0;
        const int  eConsole = 0;
        const int  CLSCTX_ALL = 23;
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK             = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM       = 0x80000000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY  = 0x08000000;
        const int  AUDCLNT_SHAREMODE_SHARED = 0;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

        static readonly Guid IID_IAudioClient        = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        static void Check(int hr, string what) {
            if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
        }

        public static void Run() {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device;
            Check(enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device),
                  "GetDefaultAudioEndpoint");

            object audioClientObj;
            Guid clsidAudioClient = IID_IAudioClient;
            Check(device.Activate(ref clsidAudioClient, CLSCTX_ALL, IntPtr.Zero, out audioClientObj),
                  "Activate(IAudioClient)");
            var audioClient = (IAudioClient)audioClientObj;

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
[WasapiLoopback.Loopback]::Run()

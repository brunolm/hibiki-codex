# Captures audio from a WASAPI endpoint and writes raw 16-bit mono PCM @
# 16 kHz to stdout (via WASAPI's built-in AUTOCONVERTPCM resampler). No
# external dependencies.
#
#   -Mode loopback     (default) captures from the default render endpoint
#                      with the LOOPBACK stream flag — what other apps play.
#   -Mode microphone   captures from a capture endpoint (default microphone
#                      unless -DeviceId is provided).
#   -Mode list-inputs  prints a JSON array of capture endpoints to stdout
#                      and exits. No audio is captured.
#
#   -DeviceId <id>     specific endpoint to use (microphone mode only).
#                      Empty/omitted = use the default capture endpoint.

param(
    [ValidateSet('loopback','microphone','list-inputs')]
    [string]$Mode = 'loopback',
    [string]$DeviceId = ''
)

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
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

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public int pid;
    }

    // PROPVARIANT laid out for x64: 24 bytes total, header at 0..7, payload
    // pointers at 8 and 16. We only read VT_LPWSTR (31) where p1 is the
    // LPWSTR; everything else is treated as unknown.
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT {
        public ushort vt;
        public ushort r1;
        public ushort r2;
        public ushort r3;
        public IntPtr p1;
        public IntPtr p2;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice dev);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig] int Activate([In] ref Guid iid, uint clsCtx, IntPtr actParams,
                                   [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore store);
        [PreserveSig] int GetId(out IntPtr pId);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue([In] ref PROPERTYKEY pkey, out PROPVARIANT pv);
        [PreserveSig] int SetValue([In] ref PROPERTYKEY pkey, [In] ref PROPVARIANT pv);
        [PreserveSig] int Commit();
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
        const int  eConsole = 0;
        const int  eCapture = 1;
        const int  CLSCTX_ALL = 23;
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK             = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM       = 0x80000000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY  = 0x08000000;
        const int  AUDCLNT_SHAREMODE_SHARED = 0;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const uint DEVICE_STATE_ACTIVE = 0x1;
        const uint STGM_READ = 0x0;
        const ushort VT_LPWSTR = 31;

        // PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, pid 14
        static PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY {
            fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
            pid   = 14
        };

        static readonly Guid IID_IAudioClient        = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pv);

        [DllImport("ole32.dll")]
        static extern void CoTaskMemFree(IntPtr ptr);

        static void Check(int hr, string what) {
            if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
        }

        static string GetDeviceId(IMMDevice dev) {
            IntPtr pId;
            Check(dev.GetId(out pId), "IMMDevice::GetId");
            string s = Marshal.PtrToStringUni(pId);
            CoTaskMemFree(pId);
            return s ?? "";
        }

        static string GetFriendlyName(IMMDevice dev) {
            IPropertyStore store;
            int hr = dev.OpenPropertyStore(STGM_READ, out store);
            if (hr != 0 || store == null) return "(unknown)";
            PROPVARIANT pv;
            hr = store.GetValue(ref PKEY_Device_FriendlyName, out pv);
            if (hr != 0) return "(unknown)";
            string name = (pv.vt == VT_LPWSTR && pv.p1 != IntPtr.Zero)
                ? Marshal.PtrToStringUni(pv.p1)
                : null;
            PropVariantClear(ref pv);
            return name ?? "(unknown)";
        }

        static string EscapeJson(string s) {
            if (s == null) return "";
            var sb = new StringBuilder(s.Length + 2);
            foreach (char c in s) {
                switch (c) {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        public static void ListEndpoints(int dataFlow) {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            string defaultId = "";
            try {
                IMMDevice def;
                if (enumerator.GetDefaultAudioEndpoint(dataFlow, eConsole, out def) == 0) {
                    defaultId = GetDeviceId(def);
                }
            } catch { /* no default device — leave defaultId empty */ }

            IMMDeviceCollection coll;
            Check(enumerator.EnumAudioEndpoints(dataFlow, DEVICE_STATE_ACTIVE, out coll),
                  "EnumAudioEndpoints");
            uint count;
            Check(coll.GetCount(out count), "IMMDeviceCollection::GetCount");

            var sb = new StringBuilder();
            sb.Append('[');
            for (uint i = 0; i < count; i++) {
                IMMDevice dev;
                if (coll.Item(i, out dev) != 0) continue;
                string id = GetDeviceId(dev);
                string name = GetFriendlyName(dev);
                bool isDefault = (id == defaultId);
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":\"").Append(EscapeJson(id))
                  .Append("\",\"name\":\"").Append(EscapeJson(name))
                  .Append("\",\"isDefault\":").Append(isDefault ? "true" : "false")
                  .Append('}');
            }
            sb.Append(']');
            var bytes = Encoding.UTF8.GetBytes(sb.ToString());
            var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }

        public static void Run(int dataFlow, bool useLoopback, string deviceId) {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device;
            if (!string.IsNullOrEmpty(deviceId)) {
                Check(enumerator.GetDevice(deviceId, out device), "GetDevice");
            } else {
                Check(enumerator.GetDefaultAudioEndpoint(dataFlow, eConsole, out device),
                      "GetDefaultAudioEndpoint");
            }

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

            uint flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                       | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            if (useLoopback) flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;

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

# eRender = 0 (output devices, used with LOOPBACK for system audio)
# eCapture = 1 (input devices, used for microphone enumeration / capture)
if ($Mode -eq 'list-inputs') {
    [WasapiLoopback.Loopback]::ListEndpoints(1)
    return
}

$dataFlow = if ($Mode -eq 'microphone') { 1 } else { 0 }
$useLoopback = ($Mode -eq 'loopback')
[WasapiLoopback.Loopback]::Run($dataFlow, $useLoopback, $DeviceId)

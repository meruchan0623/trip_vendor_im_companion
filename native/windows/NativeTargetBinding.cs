using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text.RegularExpressions;

internal static class NativeTargetBinding {
    // Tool Help is a documented read-only process snapshot; it avoids a second
    // PowerShell/CIM cold start merely to discover this helper's parent PID.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry {
        internal uint Size, Usage, ProcessId;
        internal nuint DefaultHeapId;
        internal uint ModuleId, Threads, ParentProcessId;
        internal int Priority;
        internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Image;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry entry);
    internal static uint ParentProcessId(uint processId) {
        Require(processId > 0);
        using var snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
        Require(!snapshot.IsInvalid);
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Image = "" };
        Require(Process32FirstW(snapshot, ref entry));
        do {
            if (entry.ProcessId == processId) {
                Require(entry.ParentProcessId > 0 && entry.ParentProcessId != processId);
                return entry.ParentProcessId;
            }
        } while (Process32NextW(snapshot, ref entry));
        throw new InvalidOperationException("native_parent_unavailable");
    }
    internal const string NativeSuffix = @"\resources\TripVendorCompanion\resources\native\windows\TravelMerchant.WindowHelper.exe";
    internal static string DefaultExecutable => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"vbk-electron","旅游商家桌面版.exe");
    internal static bool InstalledImage(string image)=>image.EndsWith(NativeSuffix,StringComparison.OrdinalIgnoreCase);
    static void Require(bool value){if(!value)throw new InvalidOperationException("native_target_binding_rejected");}
    internal static (string Executable,int Owner) Parse(string[] args,string nativeImage) {
        if(args.Length==0){Require(!InstalledImage(nativeImage));return(DefaultExecutable,0);}
        Require(args.Length==4&&args[0]=="--vendor-executable"&&args[2]=="--vendor-owner"&&Regex.IsMatch(args[3],"^[1-9][0-9]{0,8}$"));
        Require(InstalledImage(nativeImage));
        var root=nativeImage[..^NativeSuffix.Length];
        Require(root.Length is >3 and <=240&&Regex.IsMatch(root,@"^[A-Za-z]:\\")&&!root[2..].Contains(':')&&!root.Any(char.IsControl));
        Require(root[3..].Split('\\').All(p=>p.Length>0&&p is not ("." or "..")&&!p.EndsWith('.')&&!p.EndsWith(' ')&&p.IndexOfAny(['<','>','"','|','?','*'])<0&&!Regex.IsMatch(p,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",RegexOptions.IgnoreCase)));
        var executable=Path.Combine(root,"旅游商家桌面版.exe");Require(string.Equals(args[1],executable,StringComparison.OrdinalIgnoreCase));
        return(executable,int.Parse(args[3]));
    }
    internal static void ValidateOwner(string executable,int owner,string parentImage,string parentCommand,string ownerImage,long ownerStarted,long parentStarted,long nativeStarted) {
        var helper=Path.Combine(Path.GetDirectoryName(executable)!,"resources","TripVendorCompanion","旅游商家助手.exe");
        Require(string.Equals(parentImage,helper,StringComparison.OrdinalIgnoreCase)&&string.Equals(ownerImage,executable,StringComparison.OrdinalIgnoreCase));
        var flags=Regex.Matches(parentCommand,@"(?:^|\s)""?--vendor-owner=([^\s""]+)""?(?=\s|$)");
        Require(flags.Count==1&&flags[0].Groups[1].Value==owner.ToString()&&ownerStarted>0&&ownerStarted<=parentStarted&&parentStarted<=nativeStarted);
    }
    internal static void NoRedirects(string path) {
        Require(new DriveInfo(Path.GetPathRoot(path)!).DriveType==DriveType.Fixed);
        for(string? current=path;current!=null;current=Path.GetDirectoryName(current))Require((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0);
    }
}

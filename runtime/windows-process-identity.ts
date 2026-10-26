/** Both native helper types share one Add-Type compilation per PowerShell session. */
const NATIVE_TYPES=`if (-not ('TripVendorProcessIdentity' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class TripVendorProcessIdentity {
  [DllImport("kernel32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", CharSet=CharSet.Unicode, SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("advapi32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool CloseHandle(IntPtr handle);

  public sealed class Result { public int pid; public string executable; public string startedAt; }

  public static Result Read(int pid) {
    IntPtr process=IntPtr.Zero, token=IntPtr.Zero;
    try {
      if (pid <= 0) throw new InvalidOperationException();
      process=OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (process == IntPtr.Zero) throw new InvalidOperationException();
      var name=new StringBuilder(32768);
      uint size=(uint)name.Capacity;
      if (!QueryFullProcessImageName(process, 0, name, ref size) || size == 0 || size >= name.Capacity) throw new InvalidOperationException();
      long created, exited, kernel, user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || created <= 0) throw new InvalidOperationException();
      if (!OpenProcessToken(process, 0x0008, out token) || token == IntPtr.Zero) throw new InvalidOperationException(); // TOKEN_QUERY
      using (var owner=new WindowsIdentity(token))
      using (var current=WindowsIdentity.GetCurrent()) {
        if (owner.User == null || current.User == null || owner.User.Value != current.User.Value) throw new InvalidOperationException();
      }
      return new Result { pid=pid, executable=name.ToString(), startedAt=DateTime.FromFileTimeUtc(created).ToString("o") };
    } catch {
      throw new InvalidOperationException("PROCESS_IDENTITY_UNAVAILABLE");
    } finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }
}
// Get-CimInstance Win32_Process costs ~0.5 s per full scan; one Toolhelp snapshot
// yields the same ProcessId/Name/ExecutablePath/CommandLine fields in milliseconds.
public static class TripVendorProcessScan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct ProcessEntry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
    public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", CharSet=CharSet.Unicode, SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("ntdll.dll")]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr buffer, int length, out int returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool K32EnumProcessModules(IntPtr process, [Out] IntPtr[] modules, uint size, out uint needed);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern uint K32GetModuleFileNameExW(IntPtr process, IntPtr module, StringBuilder name, uint size);
  [DllImport("kernel32.dll")]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern bool CloseHandle(IntPtr handle);

  // ExecutablePath/Name/CommandLine match Win32_Process so the inspection scripts keep their checks.
  // ExecutablePath is the kernel image name, which resolves reparse points; LaunchPath is the loader's
  // record of the path the image was started from (what Win32_Process.ExecutablePath reported).
  public sealed class Row { public int ProcessId; public string Name; public string ExecutablePath; public string LaunchPath; public string CommandLine; }

  // The first loader module is the image as launched. Passing a null module handle would return the
  // resolved kernel path instead. The loader list can be briefly unreadable while a process starts.
  private static string LaunchPath(int pid, StringBuilder name) {
    for (int attempt=0; attempt < 3; attempt++) {
      if (attempt > 0) System.Threading.Thread.Sleep(20);
      IntPtr process=OpenProcess(0x1010, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
      if (process == IntPtr.Zero) return null;
      try {
        var modules=new IntPtr[1]; uint needed;
        if (!K32EnumProcessModules(process, modules, (uint)IntPtr.Size, out needed) || needed < (uint)IntPtr.Size || modules[0] == IntPtr.Zero) continue;
        name.Length=0;
        uint length=K32GetModuleFileNameExW(process, modules[0], name, (uint)name.Capacity);
        if (length > 0 && length < name.Capacity) return name.ToString();
      } finally { CloseHandle(process); }
    }
    return null;
  }

  // ProcessCommandLineInformation (60) returns a UNICODE_STRING whose text follows it in the same buffer.
  private static string CommandLine(IntPtr process) {
    int needed;
    NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out needed);
    if (needed <= IntPtr.Size * 2 || needed > 0x100000) return null;
    IntPtr buffer=Marshal.AllocHGlobal(needed);
    try {
      int written;
      if (NtQueryInformationProcess(process, 60, buffer, needed, out written) != 0) return null;
      int length=(ushort)Marshal.ReadInt16(buffer);
      if (length == 0) return "";
      IntPtr text=Marshal.ReadIntPtr(buffer, IntPtr.Size);
      long offset=text.ToInt64()-buffer.ToInt64();
      if (length % 2 != 0 || offset < IntPtr.Size * 2 || offset+length > needed) return null;
      return Marshal.PtrToStringUni(text, length/2);
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static Row[] Scan(string commandLineName) {
    IntPtr snapshot=CreateToolhelp32Snapshot(0x2, 0); // TH32CS_SNAPPROCESS
    if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) throw new InvalidOperationException("PROCESS_SCAN_UNAVAILABLE");
    var rows=new List<Row>();
    var name=new StringBuilder(32768);
    try {
      var entry=new ProcessEntry(); entry.dwSize=(uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32FirstW(snapshot, ref entry)) throw new InvalidOperationException("PROCESS_SCAN_UNAVAILABLE");
      do {
        var row=new Row { ProcessId=(int)entry.th32ProcessID, Name=entry.szExeFile };
        IntPtr process=OpenProcess(0x1000, false, row.ProcessId); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() == 87) continue; // ERROR_INVALID_PARAMETER: exited after the snapshot
        } else {
          try {
            uint code;
            if (GetExitCodeProcess(process, out code) && code != 259) continue; // no longer STILL_ACTIVE
            name.Length=0; uint size=(uint)name.Capacity;
            if (QueryFullProcessImageName(process, 0, name, ref size) && size > 0 && size < name.Capacity) row.ExecutablePath=name.ToString();
            if (string.Equals(row.Name, commandLineName, StringComparison.OrdinalIgnoreCase)) row.CommandLine=CommandLine(process);
          } finally { CloseHandle(process); }
          if (string.Equals(row.Name, commandLineName, StringComparison.OrdinalIgnoreCase)) row.LaunchPath=LaunchPath(row.ProcessId, name);
        }
        rows.Add(row);
      } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new InvalidOperationException("PROCESS_SCAN_INCOMPLETE"); // ERROR_NO_MORE_FILES
    } finally { CloseHandle(snapshot); }
    return rows.ToArray();
  }
}
'@
}`;
/** Reads one PID through a retained process handle and verifies its token owner. */
export function windowsProcessIdentityScript(pid:number):string {
  if(!Number.isSafeInteger(pid)||pid<=0||pid>0x7fffffff)throw new Error('INVALID_PROCESS_PID');
  return `${NATIVE_TYPES}
$identity=[TripVendorProcessIdentity]::Read(${pid});`;
}
/** Sets $all to every live process with Win32_Process field names. CommandLine and LaunchPath are
 * read only for the named client image; unreadable values stay null so callers fail closed. */
export function windowsProcessScanScript(commandLineName:string):string {
  if(!/^[\p{L}\p{N} ._()-]{1,251}\.exe$/u.test(commandLineName))throw new Error('INVALID_PROCESS_NAME');
  return `${NATIVE_TYPES}
$all=@([TripVendorProcessScan]::Scan('${commandLineName}'));`;
}

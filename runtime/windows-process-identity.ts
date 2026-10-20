/** Reads one PID through a retained process handle and verifies its token owner. */
export function windowsProcessIdentityScript(pid:number):string {
  if(!Number.isSafeInteger(pid)||pid<=0||pid>0x7fffffff)throw new Error('INVALID_PROCESS_PID');
  return `if (-not ('TripVendorProcessIdentity' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Text;
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
'@
}
$identity=[TripVendorProcessIdentity]::Read(${pid});`;
}

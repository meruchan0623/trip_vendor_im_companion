/** Ask IP Helper for the listener-only table. Some Windows builds return State=0
 * for genuine listeners. Membership in TCP_TABLE_OWNER_PID_LISTENER is the
 * listener proof; do not filter its rows a second time using the broken state. */
export function windowsTcpListenerScript(port:number,ownerPid=0):string {
  if(!Number.isSafeInteger(port)||!Number.isSafeInteger(ownerPid)||ownerPid<0||port===0&&ownerPid===0||port!==0&&(port<1024||port>65535||ownerPid!==0))throw new Error('INVALID_DEBUG_PORT');
  return `if (-not ('TripVendorTcpListeners' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class TripVendorTcpListeners {
  [DllImport("iphlpapi.dll")]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, int kind, uint reserved);
  public sealed class Row { public int pid; public string address; public int port; }
  public static Row[] Read(int port, int ownerPid) {
    var rows = new List<Row>();
    foreach (uint family in new uint[] { 2, 23 }) {
      uint size = 0;
      uint code = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
      if (code != 122) throw new InvalidOperationException("TCP_TABLE_SIZE_FAILED");
      bool complete = false;
      for (int attempt = 0; attempt < 3; attempt++) {
        if (size < 4 || size > 16777216) throw new InvalidOperationException("TCP_TABLE_SIZE_REJECTED");
        int capacity = (int)size;
        IntPtr table = Marshal.AllocHGlobal(capacity);
        try {
          code = GetExtendedTcpTable(table, ref size, false, family, 3, 0);
          if (code == 122) continue;
          if (code != 0 || size > capacity) throw new InvalidOperationException("TCP_TABLE_READ_FAILED");
          int count = Marshal.ReadInt32(table), stride = family == 2 ? 24 : 56;
          if (count < 0 || (long)count * stride + 4 > size) throw new InvalidOperationException("TCP_TABLE_ROWS_REJECTED");
          for (int i = 0; i < count; i++) {
            IntPtr row = IntPtr.Add(table, 4 + i * stride);
            int portOffset = family == 2 ? 8 : 20;
            int localPort = (Marshal.ReadByte(row, portOffset) << 8) | Marshal.ReadByte(row, portOffset + 1);
            if (port != 0 && localPort != port) continue;
            int pid = Marshal.ReadInt32(row, family == 2 ? 20 : 52);
            if (ownerPid != 0 && pid != ownerPid) continue;
            byte[] bytes = new byte[family == 2 ? 4 : 16];
            Marshal.Copy(IntPtr.Add(row, family == 2 ? 4 : 0), bytes, 0, bytes.Length);
            string address = family == 2 ? new IPAddress(bytes).ToString() : new IPAddress(bytes, (uint)Marshal.ReadInt32(row, 16)).ToString();
            if (pid <= 0) throw new InvalidOperationException("TCP_LISTENER_PID_REJECTED");
            rows.Add(new Row { pid = pid, address = address, port = localPort });
          }
          complete = true; break;
        } finally { Marshal.FreeHGlobal(table); }
      }
      if (!complete) throw new InvalidOperationException("TCP_TABLE_UNSTABLE");
    }
    return rows.ToArray();
  }
}
'@
}
$listeners=@([TripVendorTcpListeners]::Read(${port},${ownerPid}));`;
}

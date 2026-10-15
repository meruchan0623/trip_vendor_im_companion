using System.Diagnostics;
using System.Text;

internal static partial class Program
{
    static System.Windows.Forms.Timer targetAvailableTimer = null!;
    static readonly HashSet<nint> targetAvailableCandidates = new();
    static readonly Dictionary<uint, (DateTime Checked, bool Matches, Process? Pin)> availabilityProcesses = new();
    static DateTime lastTargetAvailable;

    static void QueueTargetAvailable(uint kind, nint window, int objectId, int childId)
    {
        // Native filters precede all process inspection. Descendant UIA events,
        // location changes and foreground changes create no process work.
        if (kind is not (0x8000 or 0x8002) || window == 0 || objectId != 0 || childId != 0
            || !Native.IsWindowVisible(window) || Native.GetWindow(window, 4) != 0 || Native.GetAncestor(window, 2) != window) return;
        var name = new StringBuilder(64);
        Native.GetClassName(window, name, name.Capacity);
        if (name.ToString() != "Chrome_WidgetWin_1") return;
        if (targetAvailableCandidates.Count < 64) targetAvailableCandidates.Add(window);
        if (!targetAvailableTimer.Enabled) targetAvailableTimer.Start();
    }

    static void FlushTargetAvailable()
    {
        var candidates = targetAvailableCandidates.ToArray(); targetAvailableCandidates.Clear();
        if (target != 0) return;
        var now = DateTime.UtcNow;
        foreach (var stale in availabilityProcesses.Where(pair => now - pair.Value.Checked > TimeSpan.FromSeconds(5)).Select(pair => pair.Key).ToArray())
        { availabilityProcesses[stale].Pin?.Dispose(); availabilityProcesses.Remove(stale); }
        foreach (var window in candidates)
        {
            if (!Native.IsWindow(window) || !Native.IsWindowVisible(window) || Native.GetWindow(window, 4) != 0 || Native.GetAncestor(window, 2) != window) continue;
            Native.GetWindowThreadProcessId(window, out uint pid);
            if (!availabilityProcesses.TryGetValue(pid, out var result))
            {
                bool matches = false; Process? pin = null;
                try
                {
                    pin = Process.GetProcessById((int)pid); _ = pin.SafeHandle;
                    matches = string.Equals(pin.MainModule?.FileName, ExpectedPath, StringComparison.OrdinalIgnoreCase);
                }
                catch { }
                if (!matches) { pin?.Dispose(); pin = null; }
                if (availabilityProcesses.Count >= 128) DisposeAvailabilityProcesses();
                result = (now, matches, pin); availabilityProcesses[pid] = result;
            }
            // This is an availability hint only. Binding re-enumerates and proves
            // the executable, process start time and HWND before granting access.
            if (result.Matches && result.Pin?.HasExited == false && now - lastTargetAvailable > TimeSpan.FromSeconds(1))
            { lastTargetAvailable = now; Emit("targetAvailable", new { }); return; }
        }
    }
    static void DisposeAvailabilityProcesses()
    { foreach (var entry in availabilityProcesses.Values) entry.Pin?.Dispose(); availabilityProcesses.Clear(); }
}

internal static partial class Native
{
    [System.Runtime.InteropServices.DllImport("user32.dll")] internal static extern nint GetAncestor(nint hwnd, uint flags);
}

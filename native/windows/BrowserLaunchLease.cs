using System.Diagnostics;
using System.IO;
using System.Text.Json;

internal static partial class Program
{
    sealed class BrowserLease
    {
        internal readonly string Id;
        internal readonly BrowserLaunchPolicy Policy;
        internal Process? Spawn;
        internal readonly Dictionary<uint, Process> Pins = new();
        internal bool Cancelling;
        internal BrowserLease(string id, BrowserLaunchPolicy policy) { Id = id; Policy = policy; }
    }
    static BrowserLease? browserLease;
    static string? claimedBrowserProfile;
    static readonly HashSet<string> completedBrowserLaunches = new();
    static bool browserShuttingDown;
    static DateTime browserShutdownDeadline;
    static DateTime nextBrowserCleanup;

    static BrowserProcessProof[] BrowserRows()
    {
        var result = new List<BrowserProcessProof>();
        foreach (var row in ProcessRows("Name='msedge.exe'"))
        {
            try
            {
                using var process = Process.GetProcessById((int)row.Pid);
                long ticks = process.StartTime.ToUniversalTime().Ticks;
                if (Math.Abs(ticks - row.StartedTicks) > 10 || !string.Equals(process.MainModule?.FileName, row.Path, StringComparison.OrdinalIgnoreCase)) continue;
                result.Add(new(row.Pid, ticks, row.ParentPid, row.Path, row.Command));
            } catch { }
        }
        return result.ToArray();
    }
    static bool SameProcess(uint pid, long ticks)
    {
        try { using var process = Process.GetProcessById((int)pid); return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == ticks; } catch { return false; }
    }
    static string PrivateBrowserProfile(string value)
    {
        if (!Path.IsPathFullyQualified(value) || value.StartsWith("\\\\") || value.IndexOfAny(new[] { '\r', '\n', '\0', '"' }) >= 0) throw new ArgumentException("browser_profile_denied");
        string profile = Path.GetFullPath(value).TrimEnd('\\', '/');
        if (!Path.GetFileName(profile).Equals("system-browser-profile", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("browser_profile_denied");
        for (var directory = new DirectoryInfo(profile); directory != null; directory = directory.Parent)
            if (directory.Exists && (directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("browser_profile_denied");
        if (claimedBrowserProfile != null && !string.Equals(claimedBrowserProfile, profile, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("browser_profile_denied");
        claimedBrowserProfile = profile; return profile;
    }
    static object LeaseProof(BrowserLease lease) => new { launchId = lease.Id, processId = lease.Policy.SpawnPid, startedAtTicks = lease.Policy.SpawnStartedTicks.ToString() };
    static BrowserLease RequireBrowserLease(JsonElement payload, bool keyOnly = false)
    {
        var lease = browserLease ?? throw new ArgumentException("browser_lease_unknown");
        if (payload.GetProperty("launchId").GetString() != lease.Id || !keyOnly && (payload.GetProperty("processId").GetUInt32() != lease.Policy.SpawnPid || payload.GetProperty("startedAtTicks").GetString() != lease.Policy.SpawnStartedTicks.ToString())) throw new ArgumentException("browser_lease_mismatch");
        return lease;
    }
    static void LaunchBrowser(string requestId, JsonElement payload)
    {
        try
        {
            if (browserShuttingDown || browserLease != null) { Error(requestId, "browser_cleanup_pending"); return; }
            string launchId = payload.GetProperty("launchId").GetString() ?? "";
            if (!Guid.TryParseExact(launchId, "D", out _) || completedBrowserLaunches.Contains(launchId)) throw new ArgumentException("browser_lease_mismatch");
            string profile = PrivateBrowserProfile(payload.GetProperty("profilePath").GetString() ?? ""), url = payload.GetProperty("appURL").GetString() ?? "";
            var roots = new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) };
            string executable = roots.Select(root => Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe")).FirstOrDefault(File.Exists) ?? throw new ArgumentException("edge_not_installed");
            var policy = new BrowserLaunchPolicy(profile, url, executable);
            var before = BrowserRows().Where(row => policy.Matches(row)).ToArray();
            var brokerIds = before.Select(row => row.Pid).ToHashSet();
            if (LeaseWindows(brokerIds).Count != 0) { Error(requestId, "browser_profile_busy"); return; }
            foreach (var row in before) policy.RecordBroker(row);
            Directory.CreateDirectory(profile);
            var lease = new BrowserLease(launchId, policy); browserLease = lease; // Registered before spawning, including reply/pipe failure.
            foreach (var row in before) PinBrowserProcess(lease, row.Pid, row.StartedTicks);
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            foreach (string argument in new[] { $"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--disable-background-mode", $"--app={url}", "--window-position=-32000,-32000", "--window-size=800,600" }) start.ArgumentList.Add(argument);
            lease.Spawn = Process.Start(start) ?? throw new InvalidOperationException("edge_start_failed");
            // Holding the process handle pins this identity even if the launch PID exits during handoff.
            _ = lease.Spawn.SafeHandle;
            if (!Native.GetProcessTimes(lease.Spawn.SafeHandle.DangerousGetHandle(), out long created, out _, out _, out _)) throw new InvalidOperationException("edge_identity_failed");
            policy.RecordSpawn((uint)lease.Spawn.Id, DateTime.FromFileTimeUtc(created).Ticks);
            Emit("browserLaunched", LeaseProof(lease), requestId);
        }
        catch (Exception error)
        {
            if (browserLease != null) browserLease.Cancelling = true;
            Error(requestId, error is ArgumentException && (error.Message.StartsWith("browser_") || error.Message == "edge_not_installed") ? error.Message : "browser_launch_failed");
        }
    }
    static List<nint> LeaseWindows(HashSet<uint> ids)
    {
        var result = new List<nint>();
        Native.EnumWindows((hwnd, _) =>
        {
            Native.GetWindowThreadProcessId(hwnd, out uint id);
            var name = new System.Text.StringBuilder(128); Native.GetClassName(hwnd, name, name.Capacity);
            // Includes hidden/owned app and dialog windows, excludes singleton/message-only infrastructure.
            if (ids.Contains(id) && (name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal) || name.ToString() == "#32770")) result.Add(hwnd);
            return true;
        }, 0); return result;
    }
    static HashSet<uint> VerifiedLeaseProcesses(BrowserLease lease)
    {
        if (lease.Spawn != null && lease.Spawn.HasExited) lease.Policy.SpawnExitedTicks = lease.Spawn.ExitTime.ToUniversalTime().Ticks;
        var ids = new HashSet<uint>();
        foreach (var row in BrowserRows()) if (lease.Policy.Accept(row) && PinBrowserProcess(lease, row.Pid, row.StartedTicks)) ids.Add(row.Pid);
        return ids;
    }
    static bool PinBrowserProcess(BrowserLease lease, uint pid, long ticks)
    {
        if (lease.Pins.TryGetValue(pid, out var pin)) return !pin.HasExited && pin.StartTime.ToUniversalTime().Ticks == ticks;
        var process = Process.GetProcessById((int)pid);
        _ = process.SafeHandle;
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != ticks) { process.Dispose(); return false; }
        lease.Pins.Add(pid, process); return true;
    }
    static bool SweepBrowserLease()
    {
        var lease = browserLease;
        if (lease == null) return true;
        try
        {
            if (lease.Spawn != null && lease.Policy.SpawnPid == 0)
            {
                if (!Native.GetProcessTimes(lease.Spawn.SafeHandle.DangerousGetHandle(), out long created, out _, out _, out _)) return false;
                lease.Policy.RecordSpawn((uint)lease.Spawn.Id, DateTime.FromFileTimeUtc(created).Ticks);
            }
            var ids = VerifiedLeaseProcesses(lease);
            foreach (var window in LeaseWindows(ids)) { Native.ShowWindow(window, 0); Native.PostMessage(window, 0x0010, 0, 0); }
            // No profile reuse until every pinned broker/launch identity exits; this prevents a
            // delayed old window from being confused with the next request in the same broker.
            if (lease.Policy.Owned.Any(pair => SameProcess(pair.Key, pair.Value))) return false;
            lease.Spawn?.Dispose(); foreach (var pin in lease.Pins.Values) pin.Dispose();
            if (completedBrowserLaunches.Count >= 64) completedBrowserLaunches.Clear();
            completedBrowserLaunches.Add(lease.Id); browserLease = null; return true;
        }
        catch { return false; } // Inspection failure grants no new authority and blocks reuse.
    }
    static void CleanupBrowserLaunch(string requestId, JsonElement payload)
    {
        try
        {
            string id = payload.GetProperty("launchId").GetString() ?? "";
            if (completedBrowserLaunches.Contains(id)) { Emit("browserLaunchCleaned", new { complete = true }, requestId); return; }
            var lease = RequireBrowserLease(payload, true); lease.Cancelling = true;
            ReleaseBrowser(true);
            bool complete = SweepBrowserLease();
            Emit("browserLaunchCleaned", new { complete }, requestId);
        }
        catch (ArgumentException error) { Error(requestId, error.Message.StartsWith("browser_") ? error.Message : "browser_lease_mismatch"); }
    }
    static void CheckBrowserCleanup()
    {
        if (browserLease?.Cancelling == true && DateTime.UtcNow >= nextBrowserCleanup)
        {
            nextBrowserCleanup = DateTime.UtcNow.AddSeconds(1); SweepBrowserLease();
        }
        if (browserShuttingDown && (browserLease == null || DateTime.UtcNow >= browserShutdownDeadline))
        {
            if (browserLease != null) Console.Error.WriteLine("browser_cleanup_unconfirmed");
            Application.ExitThread();
        }
    }
    static void BeginBrowserShutdown()
    {
        if (browserShuttingDown) return;
        browserShuttingDown = true; browserShutdownDeadline = DateTime.UtcNow.AddSeconds(12);
        if (browserLease != null) browserLease.Cancelling = true;
        ReleaseBrowser(true); CheckBrowserCleanup();
    }
}

internal static partial class Native
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetProcessTimes(nint process, out long created, out long exited, out long kernel, out long user);
}

using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static partial class Program
{
    sealed class ProfileWindowLease
    {
        internal string Id = "", Executable = "", ProfileDirectory = "";
        internal string Property => "TSim.Companion.ProfileLease." + Id;
        internal readonly HashSet<nint> Before = new();
        internal nint Window;
        internal Process? Pin;
        internal readonly Dictionary<nint, (Process Pin, long Started)> Owned = new();
        internal long Started;
        internal bool Cancelled, Claimed, Placed, Shown, RestoreMaximized;
        internal DateTime Heartbeat = DateTime.UtcNow, Expires = DateTime.UtcNow.AddSeconds(60);
    }
    static readonly Dictionary<string, ProfileWindowLease> profileWindows = new();
    static string? profileBrowserLeaseId;
    static DateTime? profileShutdownDeadline;
    static DateTime nextProfileScan;

    static string OfficialProfileExecutable(string kind)
    {
        if (kind != "edge" && kind != "chrome") throw new ArgumentException("browser_profile_denied");
        string vendor = kind == "edge" ? "Microsoft" : "Google", product = kind == "edge" ? "Edge" : "Chrome", executable = kind == "edge" ? "msedge.exe" : "chrome.exe";
        foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        { string path = Path.Combine(root, vendor, product, "Application", executable); if (File.Exists(path)) return Path.GetFullPath(path); }
        throw new ArgumentException("edge_not_installed");
    }
    static string ExistingSystemProfile(string kind, string directory)
    {
        if (!Regex.IsMatch(directory, "^(Default|Profile [1-9][0-9]*)$")) throw new ArgumentException("browser_profile_denied");
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), kind == "edge" ? "Microsoft" : "Google", kind == "edge" ? "Edge" : "Chrome", "User Data", directory);
        if (!Directory.Exists(path)) throw new ArgumentException("browser_profile_denied");
        for (var parent = new DirectoryInfo(path); parent != null; parent = parent.Parent)
            if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("browser_profile_denied");
        return path;
    }
    static bool ProfileTitleMatches(nint window, string id)
    {
        var title = new StringBuilder(256); Native.GetWindowText(window, title, title.Capacity);
        string expected = "TSim Companion Bootstrap " + id, actual = title.ToString();
        return actual == expected || actual == expected + " - Microsoft Edge" || actual == expected + " - Google Chrome";
    }
    static bool ProfileWindowPinned(ProfileWindowLease lease)
        => ProfileWindowPinned(lease, lease.Window);
    static bool ProfileWindowPinned(ProfileWindowLease lease, nint window)
    {
        if (window == 0 || !lease.Owned.TryGetValue(window, out var proof) || !Native.IsWindow(window) || Native.GetProp(window, lease.Property) != new nint(1)) return false;
        try { Native.GetWindowThreadProcessId(window, out uint pid); return pid == proof.Pin.Id && !proof.Pin.HasExited && proof.Pin.StartTime.ToUniversalTime().Ticks == proof.Started; } catch { return false; }
    }
    static List<nint> ProfileCandidates(ProfileWindowLease lease)
    {
        var matches = new List<nint>();
        Native.EnumWindows((window, _) =>
        {
            if (lease.Before.Contains(window) || !ProfileTitleMatches(window, lease.Id)) return true;
            var name = new StringBuilder(64); Native.GetClassName(window, name, name.Capacity); if (name.ToString() != "Chrome_WidgetWin_1") return true;
            try { Native.GetWindowThreadProcessId(window, out uint pid); using var process = Process.GetProcessById((int)pid); if (string.Equals(process.MainModule?.FileName, lease.Executable, StringComparison.OrdinalIgnoreCase)) matches.Add(window); } catch { }
            return true;
        }, 0); return matches;
    }
    static bool PinProfileWindow(ProfileWindowLease lease, nint window)
    {
        if (ProfileWindowPinned(lease, window)) return true;
        Native.GetWindowThreadProcessId(window, out uint pid); var pin = Process.GetProcessById((int)pid); _ = pin.SafeHandle;
        if (!string.Equals(pin.MainModule?.FileName, lease.Executable, StringComparison.OrdinalIgnoreCase) || !ProfileTitleMatches(window, lease.Id) || !Native.SetProp(window, lease.Property, new nint(1))) { pin.Dispose(); return false; }
        long started = pin.StartTime.ToUniversalTime().Ticks;
        if (lease.Owned.TryGetValue(window, out var previous)) previous.Pin.Dispose();
        lease.Owned[window] = (pin, started);
        if (!lease.Claimed) { lease.Pin = pin; lease.Started = started; lease.Window = window; lease.Claimed = true; }
        return ProfileWindowPinned(lease, window);
    }
    static void LaunchProfileBrowser(string requestId, JsonElement payload)
    {
        try
        {
            string id = payload.GetProperty("launchId").GetString() ?? "", kind = payload.GetProperty("browserKind").GetString() ?? "", directory = payload.GetProperty("profileDirectory").GetString() ?? "", value = payload.GetProperty("bootstrapURL").GetString() ?? "";
            if (!Guid.TryParseExact(id, "D", out _) || profileWindows.ContainsKey(id) || profileWindows.Count >= 32 || profileShutdownDeadline.HasValue) throw new ArgumentException("browser_lease_mismatch");
            if (!Uri.TryCreate(value, UriKind.Absolute, out var url) || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port <= 0 || url.UserInfo != "" || url.Query != "" || url.Fragment != "" || url.AbsolutePath != "/bootstrap/" + id) throw new ArgumentException("browser_bootstrap_denied");
            string executable = OfficialProfileExecutable(kind); ExistingSystemProfile(kind, directory);
            var lease = new ProfileWindowLease { Id = id, Executable = executable, ProfileDirectory = directory };
            Native.EnumWindows((window, _) => { lease.Before.Add(window); return true; }, 0); profileWindows.Add(id, lease);
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            // Reuse the selected installed profile. No new user-data-dir, extensions, debug port or auth transfer.
            foreach (var argument in new[] { "--profile-directory=" + directory, "--no-first-run", "--no-default-browser-check", "--app=" + value, "--window-position=-32000,-32000", "--window-size=800,600" }) start.ArgumentList.Add(argument);
            using var launched = Process.Start(start) ?? throw new ArgumentException("browser_launch_failed");
            Emit("profileBrowserLaunched", new { launchId = id }, requestId);
        }
        catch (ArgumentException error) { Error(requestId, Regex.IsMatch(error.Message, "^[a-z_]+$") ? error.Message : "browser_launch_failed"); }
        catch { Error(requestId, "browser_launch_failed"); }
    }
    static void AdoptProfileBrowser(string requestId, JsonElement payload)
    {
        try
        {
            string id = payload.GetProperty("launchId").GetString() ?? "";
            if (!profileWindows.TryGetValue(id, out var lease) || lease.Cancelled) { Error(requestId, "browser_lease_unknown"); return; }
            var candidates = ProfileCandidates(lease);
            if (candidates.Count != 1) { Error(requestId, candidates.Count == 0 ? "browser_window_pending" : "browser_window_ambiguous"); return; }
            if (!PinProfileWindow(lease, candidates[0])) { Error(requestId, "browser_identity_unverified"); return; }
            if (browser != 0 && browser != lease.Window) ReleaseBrowser(false);
            browser = lease.Window; sharedBrowserMarker = null; profileBrowserLeaseId = id; browserProfile = null;
            browserPid = (uint)lease.Pin!.Id; browserStarted = lease.Started;
            browserOriginalStyle = Native.GetWindowLongPtr(browser, -16).ToInt64(); browserDpiAtAdoption = Math.Max(96, Native.GetDpiForWindow(browser));
            // Independent windows retain Chromium's titlebar and native resizing.
            browserCaptionAtAdoption = 0;
            browserInsets = new BrowserInsets(0, 0, 0, 0);
            lastIndependentBrowserState = null;
            ResetBrowserPlacement();
            Native.SetWindowText(browser, "订单查询");
            lease.Heartbeat = DateTime.UtcNow; Emit("profileBrowserAdopted", new { launchId = id }, requestId); lastState = null; EmitWindowState();
        }
        catch { Error(requestId, "browser_adoption_failed"); }
    }
    static void CloseProfileWindows(ProfileWindowLease lease)
    {
        foreach (var window in lease.Owned.Keys.ToArray()) if (ProfileWindowPinned(lease, window)) { Native.ShowWindow(window, 0); Native.PostMessage(window, 0x0010, 0, 0); }
        foreach (var candidate in ProfileCandidates(lease))
        {
            // Ambiguous/late candidates still require this lease's unpredictable bootstrap title,
            // a new HWND and the exact installed executable before each close.
            try { if (PinProfileWindow(lease, candidate)) { Native.ShowWindow(candidate, 0); Native.PostMessage(candidate, 0x0010, 0, 0); } } catch { }
        }
    }
    static void CleanupProfileBrowser(string requestId, JsonElement payload)
    {
        string id = payload.GetProperty("launchId").GetString() ?? "";
        if (!profileWindows.TryGetValue(id, out var lease)) { Error(requestId, "browser_lease_unknown"); return; }
        lease.Cancelled = true; lease.Expires = DateTime.UtcNow.AddSeconds(60); CloseProfileWindows(lease);
        if (profileBrowserLeaseId == id) ReleaseBrowser(true);
        Emit("profileBrowserCleaned", new { complete = lease.Claimed && lease.Owned.Keys.All(window => !ProfileWindowPinned(lease, window)) }, requestId);
    }
    static void HeartbeatProfileBrowser(string requestId, JsonElement payload)
    {
        string id = payload.GetProperty("launchId").GetString() ?? "";
        if (!profileWindows.TryGetValue(id, out var lease) || lease.Cancelled) { Error(requestId, "browser_lease_unknown"); return; }
        lease.Heartbeat = DateTime.UtcNow; Emit("profileBrowserHeartbeat", new { }, requestId);
    }
    static bool ProfileBrowserStillOwned(nint window) => profileBrowserLeaseId == null || profileWindows.TryGetValue(profileBrowserLeaseId, out var lease) && lease.Window == window && !lease.Cancelled && ProfileWindowPinned(lease);
    static void CheckProfileBrowserWindows()
    {
        if (DateTime.UtcNow < nextProfileScan) return; nextProfileScan = DateTime.UtcNow.AddSeconds(2);
        foreach (var lease in profileWindows.Values.ToArray())
        {
            if (!lease.Cancelled && DateTime.UtcNow - lease.Heartbeat > TimeSpan.FromSeconds(12)) { lease.Cancelled = true; lease.Expires = DateTime.UtcNow.AddSeconds(60); }
            if (lease.Cancelled) CloseProfileWindows(lease);
            if (lease.Cancelled && DateTime.UtcNow >= lease.Expires) { foreach (var proof in lease.Owned) { if (Native.GetProp(proof.Key, lease.Property) == new nint(1)) Native.RemoveProp(proof.Key, lease.Property); proof.Value.Pin.Dispose(); } profileWindows.Remove(lease.Id); }
        }
        if (profileShutdownDeadline.HasValue && (profileWindows.Values.All(lease => lease.Claimed && lease.Owned.Keys.All(window => !ProfileWindowPinned(lease, window))) || DateTime.UtcNow >= profileShutdownDeadline))
        {
            if (profileWindows.Values.Any(lease => !lease.Claimed || lease.Owned.Keys.Any(window => ProfileWindowPinned(lease, window)))) Console.Error.WriteLine("profile_browser_cleanup_unconfirmed");
            BeginBrowserShutdown();
        }
    }
    static void BeginAllBrowserShutdown()
    {
        if (profileShutdownDeadline.HasValue) return;
        foreach (var lease in profileWindows.Values) { lease.Cancelled = true; CloseProfileWindows(lease); }
        if (profileWindows.Count == 0) { BeginBrowserShutdown(); return; }
        profileShutdownDeadline = DateTime.UtcNow.AddSeconds(12); CheckProfileBrowserWindows();
    }
}
internal static partial class Native
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool SetWindowText(nint hwnd, string text);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool SetProp(nint hwnd, string name, nint value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern nint GetProp(nint hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern nint RemoveProp(nint hwnd, string name);
}

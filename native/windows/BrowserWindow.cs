using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text;
using System.Windows.Automation;

internal static partial class Program
{
    static uint? parentPid;
    static uint browserPid;
    static long browserStarted;
    static int browserCaptionAtAdoption;
    static uint browserDpiAtAdoption;
    sealed record BrowserInsets(int Left, int Top, int Right, int Bottom);
    static BrowserInsets browserInsets = new(0, 0, 0, 0);
    static BrowserPlacementGeometry? browserPlacementState;
    static bool browserOriginalTopmost;
    static void ResetBrowserPlacement(bool captureOriginal = true)
    {
        browserPlacementState = null;
        if (captureOriginal) browserOriginalTopmost = (Native.GetWindowLongPtr(browser, -20).ToInt64() & 0x00000008L) != 0;
    }
    static uint ParentProcessId()
    {
        if (parentPid.HasValue) return parentPid.Value;
        parentPid = NativeTargetBinding.ParentProcessId((uint)Environment.ProcessId);
        return parentPid ?? throw new InvalidOperationException("parent_unavailable");
    }

    // Bounded read-only CIM inspection also handles Chromium handing the launch PID to a broker.
    // Native COM SWbem automation is not dependable in a single-file .NET helper on every host.
    static List<(uint Pid, uint ParentPid, string Path, string Command, long StartedTicks)> ProcessRows(string filter, int timeoutMs = 3500)
    {
        var results = new List<(uint, uint, string, string, long)>();
        string script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$rows=@(Get-CimInstance Win32_Process -Filter '" + filter.Replace("'", "''") + "'|ForEach-Object {@{Pid=[uint32]$_.ProcessId;ParentPid=[uint32]$_.ParentProcessId;Path=[string]$_.ExecutablePath;Command=[string]$_.CommandLine;StartedTicks=([DateTime]$_.CreationDate).ToUniversalTime().Ticks.ToString()}});ConvertTo-Json -InputObject $rows -Compress";
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8 };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) }) start.ArgumentList.Add(arg);
        using var reader = Process.Start(start) ?? throw new InvalidOperationException("process_inspection_failed");
        var stdout = reader.StandardOutput.ReadToEndAsync(); var stderr = reader.StandardError.ReadToEndAsync();
        if (!reader.WaitForExit(timeoutMs)) { reader.Kill(); throw new InvalidOperationException("process_inspection_timeout"); }
        string output = stdout.GetAwaiter().GetResult();
        if (reader.ExitCode != 0 || !string.IsNullOrWhiteSpace(stderr.GetAwaiter().GetResult()) || output.Length > 524288) throw new InvalidOperationException("process_inspection_failed");
        using var document = JsonDocument.Parse(output);
        foreach (var row in document.RootElement.EnumerateArray())
        {
            results.Add((row.GetProperty("Pid").GetUInt32(), row.GetProperty("ParentPid").GetUInt32(), row.GetProperty("Path").GetString() ?? "", row.GetProperty("Command").GetString() ?? "", long.Parse(row.GetProperty("StartedTicks").GetString() ?? "0")));
        }
        return results;
    }

    static void AdoptBrowser(string requestId, JsonElement payload)
    {
        try
        {
            var lease = RequireBrowserLease(payload);
            if (lease.Cancelling) { Error(requestId, "browser_launch_cancelled"); return; }
            var windows = LeaseWindows(VerifiedLeaseProcesses(lease)).Where(hwnd => Native.IsWindowVisible(hwnd) && Native.GetWindow(hwnd, 4) == 0).ToList();
            if (windows.Count != 1) { Error(requestId, windows.Count == 0 ? "browser_window_pending" : "browser_window_ambiguous"); return; }
            if (browser != 0 && browser != windows[0]) ReleaseBrowser(false);
            bool alreadyAdopted = browser == windows[0] && BrowserStillOwned();
            browser = windows[0]; browserProfile = lease.Policy.Profile;
            Native.GetWindowThreadProcessId(browser, out browserPid);
            using (var process = Process.GetProcessById((int)browserPid)) browserStarted = process.StartTime.ToUniversalTime().Ticks;
            if (!alreadyAdopted) browserOriginalStyle = Native.GetWindowLongPtr(browser, -16).ToInt64();
            browserDpiAtAdoption = Math.Max(96, Native.GetDpiForWindow(browser));
            browserCaptionAtAdoption = MeasureAppCaption(browser, browserDpiAtAdoption);
            // Remove system chrome only, preserve app content. Never make the browser globally topmost.
            Native.SetWindowLongPtr(browser, -16, new nint(browserOriginalStyle & ~(0x00C00000L | 0x00040000L | 0x00800000L)));
            Native.SetWindowPos(browser, 0, 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0004 | 0x0010);
            browserInsets = RendererInsets(browser) ?? BrowserDocumentInsets(browser) ?? new BrowserInsets(0, browserCaptionAtAdoption, 0, 0);
            ResetBrowserPlacement(!alreadyAdopted);
            Emit("browserAdopted", new { handle = browser.ToInt64().ToString(), profileMatched = true, borderless = (Native.GetWindowLongPtr(browser, -16).ToInt64() & (0x00C00000L | 0x00040000L | 0x00800000L)) == 0, captionCrop = browserInsets.Top, cropInsets = browserInsets, dpi = browserDpiAtAdoption }, requestId);
            lastState = null; EmitWindowState();
        }
        catch (ArgumentException error) { Error(requestId, error.Message.StartsWith("browser_") ? error.Message : "browser_lease_mismatch"); }
        catch { Error(requestId, "browser_adoption_failed"); }
    }

    static void PlaceBrowser(string requestId, JsonElement payload)
    {
        if (!BrowserStillOwned()) { browser = 0; Error(requestId, "browser_not_adopted"); return; }
        var bounds = payload.GetProperty("bounds");
        int x = bounds.GetProperty("x").GetInt32(), y = bounds.GetProperty("y").GetInt32(), width = bounds.GetProperty("width").GetInt32(), height = bounds.GetProperty("height").GetInt32();
        if (!IndependentBrowserGeometry.Valid(x, y, width, height)) throw new ArgumentException();
        bool visible = payload.GetProperty("visible").GetBoolean();
        bool restack = payload.TryGetProperty("restack", out var stacking) && stacking.ValueKind == JsonValueKind.True;
        if (profileBrowserLeaseId != null)
        {
            PlaceIndependentProfileBrowser(requestId, payload, new PixelBounds(x, y, width, height), visible);
            return;
        }
        // The browser and local action bar share topmost only while their approved group
        // owns foreground. No HWND owner changes touch the user's ordinary Edge windows.
        uint oldDpi = Math.Max(96, Native.GetDpiForWindow(browser));
        double factor = (double)oldDpi / browserDpiAtAdoption;
        var inset = new BrowserInsets((int)Math.Round(browserInsets.Left * factor), (int)Math.Round(browserInsets.Top * factor), (int)Math.Round(browserInsets.Right * factor), (int)Math.Round(browserInsets.Bottom * factor));
        var current = new BrowserPlacementGeometry(x, y, width, height, oldDpi, inset.Left, inset.Top, inset.Right, inset.Bottom, visible);
        var plan = BrowserPlacementPolicy.Decide(browserPlacementState, current, restack);
        bool visibilityChanged = Native.IsWindowVisible(browser) != visible;
        bool stack = plan.Stack || visibilityChanged;
        uint flags = 0x0010u | (plan.Resize ? 0u : 0x0001u) | (plan.Move ? 0u : 0x0002u) | (stack ? 0u : 0x0004u);
        if ((plan.Move || plan.Resize || stack) && !Native.SetWindowPos(browser, stack ? new nint(visible ? -1 : -2) : 0, x - inset.Left, y - inset.Top, width + inset.Left + inset.Right, height + inset.Top + inset.Bottom, flags)) { Error(requestId, "browser_placement_failed"); return; }
        uint newDpi = Math.Max(96, Native.GetDpiForWindow(browser));
        bool regionChanged = plan.Region;
        if (newDpi != oldDpi)
        {
            factor = (double)newDpi / browserDpiAtAdoption;
            inset = new BrowserInsets((int)Math.Round(browserInsets.Left * factor), (int)Math.Round(browserInsets.Top * factor), (int)Math.Round(browserInsets.Right * factor), (int)Math.Round(browserInsets.Bottom * factor));
            if (!Native.SetWindowPos(browser, 0, x - inset.Left, y - inset.Top, width + inset.Left + inset.Right, height + inset.Top + inset.Bottom, 0x0014u)) { Error(requestId, "browser_placement_failed"); return; }
            regionChanged = true;
        }
        // Edge app titlebars are Chromium-drawn inside the client rectangle. Clip that strip
        // at the OS window region, preserving a complete page viewport of the requested height.
        if (regionChanged)
        {
            // This may apply a full-viewport fallback while the title is stale.
            // Always revalidate after resize, including a fast A -> B -> A return.
            componentRegionCache.Invalidate();
            if (!ApplyBrowserComponentRegion(inset, width, height)) { Error(requestId, "browser_crop_failed"); return; }
        }
        if (visibilityChanged) Native.ShowWindow(browser, visible ? 4 : 0); // SW_SHOWNOACTIVATE / SW_HIDE
        browserPlacementState = new BrowserPlacementGeometry(x, y, width, height, newDpi, inset.Left, inset.Top, inset.Right, inset.Bottom, visible);
        Native.GetWindowRect(browser, out var actual);
        Emit("browserPlaced", new { visible = Native.IsWindowVisible(browser), captionCrop = inset.Top, cropInsets = inset, bounds = new { x = actual.Left + inset.Left, y = actual.Top + inset.Top, width = actual.Right - actual.Left - inset.Left - inset.Right, height = actual.Bottom - actual.Top - inset.Top - inset.Bottom } }, requestId);
    }

    static void ReleaseBrowser(bool close)
    {
        if (BrowserStillOwned())
        {
            if (close) { Native.ShowWindow(browser, 0); Native.PostMessage(browser, 0x0010, 0, 0); }
            else if (profileBrowserLeaseId == null)
            {
                Native.SetWindowRgn(browser, 0, true);
                Native.SetWindowLongPtr(browser, -16, new nint(browserOriginalStyle));
                Native.SetWindowPos(browser, new nint(browserOriginalTopmost ? -1 : -2), 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0010);
            }
        }
        browser = 0; browserProfile = null; sharedBrowserMarker = null; profileBrowserLeaseId = null; browserPlacementState = null; lastIndependentBrowserState = null;
    }

    static bool BrowserStillOwned()
    {
        if (browser == 0 || !Native.IsWindow(browser)) return false;
        try
        {
            Native.GetWindowThreadProcessId(browser, out uint pid);
            using var process = Process.GetProcessById((int)pid);
            return pid == browserPid && process.StartTime.ToUniversalTime().Ticks == browserStarted
                && (sharedBrowserMarker == null || SharedBrowserTitleMatches(browser, sharedBrowserMarker)) && ProfileBrowserStillOwned(browser);
        }
        catch { return false; }
    }

    static void CheckBrowser()
    {
        if (browser == 0 || BrowserStillOwned()) return;
        browser = 0; browserProfile = null; profileBrowserLeaseId = null; sharedBrowserMarker = null; lastState = null;
        Emit("browserLost", new { reason = "browser_closed" });
    }

    static int MeasureAppCaption(nint handle, uint dpi)
    {
        Native.GetWindowRect(handle, out var rectangle);
        try
        {
            // Inspect browser chrome only. Never descend into the remote web document.
            var queue = new Queue<AutomationElement>(); queue.Enqueue(AutomationElement.FromHandle(handle));
            var clock = Stopwatch.StartNew(); int visited = 0;
            while (queue.Count > 0 && ++visited < 160 && clock.ElapsedMilliseconds < 1200)
            {
                var node = queue.Dequeue(); var info = node.Current;
                if (info.ControlType == ControlType.Document) continue;
                if (info.ControlType == ControlType.Button && new[] { "Minimize", "Maximize", "Restore", "Close", "最小化", "最大化", "还原", "关闭" }.Any(label => info.Name.Equals(label, StringComparison.OrdinalIgnoreCase)))
                {
                    int bottom = (int)Math.Round(info.BoundingRectangle.Bottom - rectangle.Top);
                    if (bottom >= 20 * dpi / 96 && bottom <= 60 * dpi / 96) return bottom;
                }
                var child = TreeWalker.ControlViewWalker.GetFirstChild(node);
                while (child != null && visited + queue.Count < 160) { queue.Enqueue(child); child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            }
        }
        catch { /* App chrome accessibility is optional; the pinned Edge fixture validates fallback. */ }
        // Verified installed Edge app chrome is 44 physical pixels at 144 DPI (29 1/3 DIP).
        return (int)Math.Round(44d * dpi / 144);
    }

    static BrowserInsets? RendererInsets(nint handle)
    {
        if (!Native.GetWindowRect(handle, out var root)) return null;
        BrowserInsets? found = null; long area = 0;
        Native.EnumChildWindows(handle, (child, _) =>
        {
            var name = new StringBuilder(128); Native.GetClassName(child, name, name.Capacity);
            if (name.ToString() != "Chrome_RenderWidgetHostHWND" || !Native.GetWindowRect(child, out var rect)) return true;
            int left = rect.Left - root.Left, top = rect.Top - root.Top, right = root.Right - rect.Right, bottom = root.Bottom - rect.Bottom;
            long current = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
            // Only an interior page viewport, never a full-window browser compositor or popup.
            if (left is >= 0 and <= 80 && right is >= 0 and <= 80 && top is >= 20 and <= 160 && bottom is >= 0 and <= 80 && current > area)
            { found = new BrowserInsets(left, top, right, bottom); area = current; }
            return true;
        }, 0);
        return found;
    }

    static BrowserInsets? BrowserDocumentInsets(nint handle)
    {
        if (!Native.GetWindowRect(handle, out var root)) return null;
        try
        {
            var queue = new Queue<AutomationElement>(); queue.Enqueue(AutomationElement.FromHandle(handle));
            int visited = 0; var clock = Stopwatch.StartNew();
            while (queue.Count > 0 && ++visited < 160 && clock.ElapsedMilliseconds < 1200)
            {
                var node = queue.Dequeue(); var info = node.Current;
                if (info.ControlType == ControlType.Document)
                {
                    // Read the outer viewport rectangle only, never webpage text, values or descendants.
                    var box = info.BoundingRectangle;
                    var inset = new BrowserInsets((int)Math.Round(box.Left - root.Left), (int)Math.Round(box.Top - root.Top), (int)Math.Round(root.Right - box.Right), (int)Math.Round(root.Bottom - box.Bottom));
                    if (inset.Left is >= 0 and <= 80 && inset.Right is >= 0 and <= 80 && inset.Top is >= 20 and <= 160 && inset.Bottom is >= 0 and <= 80 && box.Width > 200 && box.Height > 100) return inset;
                    continue;
                }
                var child = TreeWalker.ControlViewWalker.GetFirstChild(node);
                while (child != null && queue.Count + visited < 160) { queue.Enqueue(child); child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            }
        }
        catch { }
        return null;
    }
}

internal static partial class Native
{
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern nint GetWindowLongPtr(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] internal static extern nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool PostMessage(nint hwnd, uint message, nint wparam, nint lparam);
    [DllImport("gdi32.dll")] internal static extern nint CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("user32.dll")] internal static extern int SetWindowRgn(nint hwnd, nint region, bool redraw);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(nint handle);
    [DllImport("user32.dll")] internal static extern bool EnumChildWindows(nint hwnd, EnumDelegate callback, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(nint hwnd, StringBuilder name, int size);
}

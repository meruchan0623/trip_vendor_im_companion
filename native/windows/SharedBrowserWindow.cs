using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static partial class Program
{
    static string? sharedBrowserMarker;
    static bool OfficialSharedBrowser(Process process)
    {
        string path = System.IO.Path.GetFullPath(process.MainModule?.FileName ?? "");
        var roots = new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) };
        return roots.Where(root => !string.IsNullOrEmpty(root)).Any(root =>
            string.Equals(path, System.IO.Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe"), StringComparison.OrdinalIgnoreCase) ||
            string.Equals(path, System.IO.Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe"), StringComparison.OrdinalIgnoreCase));
    }
    static bool SharedBrowserTitleMatches(nint hwnd, string marker)
    {
        var title = new StringBuilder(512); Native.GetWindowText(hwnd, title, title.Capacity);
        string expected = "TSim Companion Order " + marker;
        string actual = title.ToString();
        return actual == expected || actual == expected + " - Google Chrome" || actual == expected + " - Microsoft Edge";
    }
    static void AdoptSharedBrowser(string requestId, JsonElement payload)
    {
        try
        {
            string marker = payload.GetProperty("marker").GetString() ?? "";
            if (!Guid.TryParseExact(marker, "D", out _)) throw new ArgumentException();
            if (browserLease != null) { Error(requestId, "browser_cleanup_pending"); return; }
            var matches = new List<nint>();
            Native.EnumWindows((hwnd, _) =>
            {
                if (!Native.IsWindowVisible(hwnd) || Native.GetWindow(hwnd, 4) != 0 || !SharedBrowserTitleMatches(hwnd, marker)) return true;
                try
                {
                    Native.GetWindowThreadProcessId(hwnd, out uint pid);
                    using var process = Process.GetProcessById((int)pid);
                    var name = new StringBuilder(128); Native.GetClassName(hwnd, name, name.Capacity);
                    if (name.ToString() == "Chrome_WidgetWin_1" && OfficialSharedBrowser(process)) matches.Add(hwnd);
                }
                catch { }
                return true;
            }, 0);
            if (matches.Count != 1) { Error(requestId, matches.Count == 0 ? "browser_window_pending" : "browser_window_ambiguous"); return; }
            if (browser != 0) ReleaseBrowser(false);
            browser = matches[0]; sharedBrowserMarker = marker; browserProfile = null;
            Native.GetWindowThreadProcessId(browser, out browserPid);
            using (var process = Process.GetProcessById((int)browserPid)) browserStarted = process.StartTime.ToUniversalTime().Ticks;
            browserOriginalStyle = Native.GetWindowLongPtr(browser, -16).ToInt64();
            browserDpiAtAdoption = Math.Max(96, Native.GetDpiForWindow(browser));
            browserCaptionAtAdoption = MeasureAppCaption(browser, browserDpiAtAdoption);
            Native.SetWindowLongPtr(browser, -16, new nint(browserOriginalStyle & ~(0x00C00000L | 0x00040000L | 0x00800000L)));
            Native.SetWindowPos(browser, 0, 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0004 | 0x0010);
            browserInsets = RendererInsets(browser) ?? BrowserDocumentInsets(browser) ?? new BrowserInsets(0, browserCaptionAtAdoption, 0, 0);
            ResetBrowserPlacement();
            Emit("browserAdopted", new { borderless = true, sharedSession = true }, requestId);
            lastState = null; EmitWindowState();
        }
        catch { Error(requestId, "browser_adoption_failed"); }
    }
}
internal static partial class Native
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint hwnd, StringBuilder text, int count);
}

using System.Text;

internal static partial class Program
{
    static readonly BrowserComponentRegionCache componentRegionCache = new();
    static ComponentGeometry? ReadBrowserComponentGeometry(int width, int height)
    {
        if (profileBrowserLeaseId == null || !BrowserStillOwned()) return null;
        var title = new StringBuilder(770); Native.GetWindowText(browser, title, title.Capacity);
        var geometry = BrowserComponentGeometry.Parse(title.ToString(), profileBrowserLeaseId, width, height, validateViewport: false);
        if (geometry != null) Native.SetWindowText(browser, "订单查询");
        return geometry;
    }
    static bool ApplyBrowserComponentRegion(BrowserInsets inset, int width, int height)
    {
        if (profileBrowserLeaseId != null) return true;
        var geometry = ReadBrowserComponentGeometry(width, height);
        var rect = geometry?.Rect ?? new ComponentRect(0, 0, width, height);
        nint region = Native.CreateRectRgn(inset.Left + rect.X, inset.Top + rect.Y, inset.Left + rect.X + rect.Width, inset.Top + rect.Y + rect.Height);
        if (region == 0 || Native.SetWindowRgn(browser, region, true) == 0) { if (region != 0) Native.DeleteObject(region); return false; }
        return true;
    }
    static void CheckBrowserComponentGeometry()
    {
        if (profileBrowserLeaseId == null || !BrowserStillOwned()) { componentRegionCache.Invalidate(); return; }
        if (!Native.GetClientRect(browser, out var viewport)) return;
        int width = viewport.Right - viewport.Left, height = viewport.Bottom - viewport.Top;
        var geometry = ReadBrowserComponentGeometry(width, height);
        // The existing lease-scoped title channel is only a terminal-close signal.
        // Independent profile windows never install an OS clipping region.
        if (geometry?.Closed != true) return;
        var key = BrowserComponentGeometry.StateKey(profileBrowserLeaseId, width, height, Native.GetDpiForWindow(browser), geometry);
        if (componentRegionCache.IsCurrent(key)) return;
        componentRegionCache.MarkApplied(key);
        Emit("browserComponentGeometry", new { launchId = profileBrowserLeaseId, closed = true, rect = (ComponentRect?)null });
    }
}

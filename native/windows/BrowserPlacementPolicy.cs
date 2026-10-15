// Pure placement decisions keep the high-rate drag path free of resize/redraw/show work.
internal sealed record BrowserPlacementGeometry(int X, int Y, int Width, int Height, uint Dpi, int Left, int Top, int Right, int Bottom, bool Visible);
internal sealed record BrowserPlacementDecision(bool Move, bool Resize, bool Region, bool Show, bool Stack);
internal static class IndependentBrowserGeometry
{
    internal static bool Valid(int x, int y, int width, int height)
        => Math.Abs((long)x) <= 100000 && Math.Abs((long)y) <= 100000 && width is >= 100 and <= 20000 && height is >= 100 and <= 20000;
    internal static (int X, int Y, int Width, int Height) WorkspaceToScreen(int left, int top, int right, int bottom, int workLeft, int workTop, int monitorLeft, int monitorTop)
        => (left + workLeft - monitorLeft, top + workTop - monitorTop, right - left, bottom - top);
}
internal static class BrowserPlacementPolicy
{
    internal static BrowserPlacementDecision Decide(BrowserPlacementGeometry? previous, BrowserPlacementGeometry current, bool restack)
    {
        bool resize = previous == null || previous.Width != current.Width || previous.Height != current.Height || previous.Dpi != current.Dpi
            || previous.Left != current.Left || previous.Top != current.Top || previous.Right != current.Right || previous.Bottom != current.Bottom;
        bool show = previous == null || previous.Visible != current.Visible;
        return new(previous == null || previous.X != current.X || previous.Y != current.Y || previous.Left != current.Left || previous.Top != current.Top, resize, resize, show, show || restack && current.Visible);
    }
}

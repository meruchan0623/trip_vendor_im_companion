using System.Runtime.InteropServices;
using System.Text.Json;

internal static partial class Program
{
    sealed record IndependentBrowserState(string LaunchId, PixelBounds Bounds, bool Maximized);
    static IndependentBrowserState? lastIndependentBrowserState;
    static System.Windows.Forms.Timer browserStateTimer = null!;

    static void PlaceIndependentProfileBrowser(string requestId, JsonElement payload, PixelBounds bounds, bool visible)
    {
        var lease = profileWindows[profileBrowserLeaseId!];
        // A lease has one initialization. Subsequent placement commands cannot
        // fight a user drag, minimize, maximize, or cross-monitor DPI transition.
        if (!lease.Placed)
        {
            if (!Native.SetWindowPos(browser, 0, bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x0014))
            { Error(requestId, "browser_placement_failed"); return; }
            lease.Placed = true;
            lease.RestoreMaximized = payload.TryGetProperty("maximized", out var value) && value.GetBoolean();
            if (!visible) Native.ShowWindow(browser, 0);
        }
        // Bootstrap initializes hidden, then releases navigation, then reveals.
        // Honor that first reveal without reapplying bounds or subsequent host visibility.
        if (visible && !lease.Shown)
        { lease.Shown = true; Native.ShowWindow(browser, lease.RestoreMaximized ? 3 : 4); }
        EmitIndependentBrowserState();
        Native.GetWindowRect(browser, out var actual);
        Emit("browserPlaced", new { visible = Native.IsWindowVisible(browser), captionCrop = 0, cropInsets = new BrowserInsets(0, 0, 0, 0), bounds = new PixelBounds(actual.Left, actual.Top, actual.Right - actual.Left, actual.Bottom - actual.Top) }, requestId);
    }

    static void QueueIndependentBrowserState()
    {
        // Restarting makes this a trailing debounce, including keyboard resize
        // and DPI bursts that have no explicit move-end event.
        browserStateTimer.Stop(); browserStateTimer.Start();
    }

    static void EmitIndependentBrowserState()
    {
        if (profileBrowserLeaseId == null || !profileWindows.TryGetValue(profileBrowserLeaseId, out var lease)
            || !lease.Shown || !BrowserStillOwned() || Native.IsIconic(browser)) return;
        bool maximized = Native.IsZoomed(browser);
        Native.Rect rect;
        if (maximized)
        {
            var placement = new Native.WindowPlacement { Length = Marshal.SizeOf<Native.WindowPlacement>() };
            if (!Native.GetWindowPlacement(browser, ref placement)) return;
            rect = placement.NormalPosition;
            // WINDOWPLACEMENT uses workspace coordinates for ordinary windows.
            // Convert to physical screen coordinates before persisting them.
            if ((Native.GetWindowLongPtr(browser, -20).ToInt64() & 0x80) == 0)
            {
                var monitor = new Native.MonitorInfo { Size = Marshal.SizeOf<Native.MonitorInfo>() };
                if (!Native.GetMonitorInfo(Native.MonitorFromRect(ref rect, 2), ref monitor)) return;
                var normal = IndependentBrowserGeometry.WorkspaceToScreen(rect.Left, rect.Top, rect.Right, rect.Bottom, monitor.Work.Left, monitor.Work.Top, monitor.Monitor.Left, monitor.Monitor.Top);
                rect = new Native.Rect { Left = normal.X, Top = normal.Y, Right = normal.X + normal.Width, Bottom = normal.Y + normal.Height };
            }
        }
        else if (!Native.GetWindowRect(browser, out rect)) return;
        var bounds = new PixelBounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        if (!IndependentBrowserGeometry.Valid(bounds.X, bounds.Y, bounds.Width, bounds.Height)) return;
        var state = new IndependentBrowserState(profileBrowserLeaseId, bounds, maximized);
        if (lastIndependentBrowserState == state) return;
        lastIndependentBrowserState = state;
        Emit("browserWindowState", state);
    }
}

internal static partial class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct WindowPlacement { public int Length; public uint Flags, ShowCommand; public Point MinPosition, MaxPosition; public Rect NormalPosition; }
    [StructLayout(LayoutKind.Sequential)] internal struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] internal static extern bool IsZoomed(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool GetWindowPlacement(nint hwnd, ref WindowPlacement placement);
    [DllImport("user32.dll")] internal static extern nint MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);
}

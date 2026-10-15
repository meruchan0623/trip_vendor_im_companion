using System.Text;
using System.Text.Json;

// This geometry channel reads the already-owned app HWND's title only. It never
// traverses the remote document, reads values or transfers authentication.
internal sealed record ComponentRect(int X, int Y, int Width, int Height);
internal sealed record ComponentGeometry(bool Closed, ComponentRect? Rect);
// A SetWindowRgn replacement invalidates the last title-derived region even if
// the viewport later returns to its earlier size before another title event.
internal sealed class BrowserComponentRegionCache
{
    string? applied;
    internal bool IsCurrent(string key) => key == applied;
    internal void MarkApplied(string key) => applied = key;
    internal void Invalidate() => applied = null;
}
internal static class BrowserComponentGeometry
{
    internal const string Prefix = "TSim Companion Geometry ";
    internal static string StateKey(string lease, int width, int height, uint dpi, ComponentGeometry? geometry)
        => JsonSerializer.Serialize(new { lease, width, height, dpi, geometry });
    internal static ComponentGeometry? Parse(string title, string lease, int width, int height, bool validateViewport = true)
    {
        if (!Guid.TryParseExact(lease, "D", out _) || title.Length > 768 || !title.StartsWith(Prefix + lease + " ", StringComparison.Ordinal)) return null;
        var json = title[(Prefix.Length + lease.Length + 1)..];
        foreach (string suffix in new[] { " - Microsoft Edge", " - Google Chrome" })
            if (json.EndsWith(suffix, StringComparison.Ordinal)) json = json[..^suffix.Length];
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (!Keys(root, "v", "viewport", "rect", "closed") || root.GetProperty("v").GetInt32() != 1) return null;
            var viewport = root.GetProperty("viewport");
            if (!Keys(viewport, "width", "height", "dpr")) return null;
            double w = Number(viewport, "width"), h = Number(viewport, "height"), dpr = Number(viewport, "dpr");
            if (w is < 1 or > 20000 || h is < 1 or > 20000 || dpr is < 0.5 or > 8) return null;
            bool closed = root.GetProperty("closed").GetBoolean();
            var rect = root.GetProperty("rect");
            // Closing is lease-scoped, not geometry-scoped. A pending DPI/viewport
            // resize must not swallow the component's terminal close event.
            if (closed) return rect.ValueKind == JsonValueKind.Null ? new(true, null) : null;
            if (validateViewport && (Math.Abs(w * dpr - width) > 4 || Math.Abs(h * dpr - height) > 4)) return null;
            if (!validateViewport) { width = (int)Math.Round(w * dpr); height = (int)Math.Round(h * dpr); }
            if (rect.ValueKind == JsonValueKind.Null) return new(false, null);
            if (!Keys(rect, "x", "y", "width", "height")) return null;
            double x = Number(rect, "x"), y = Number(rect, "y"), rw = Number(rect, "width"), rh = Number(rect, "height");
            if (x < 0 || y < 0 || rw <= 0 || rh <= 0 || x + rw > w + 0.01 || y + rh > h + 0.01) return null;
            int left = Math.Max(0, (int)Math.Floor(x * dpr)), top = Math.Max(0, (int)Math.Floor(y * dpr));
            int right = Math.Min(width, (int)Math.Ceiling((x + rw) * dpr)), bottom = Math.Min(height, (int)Math.Ceiling((y + rh) * dpr));
            return right > left && bottom > top ? new(false, new(left, top, right - left, bottom - top)) : null;
        }
        catch { return null; }
    }
    static bool Keys(JsonElement element, params string[] keys) => element.ValueKind == JsonValueKind.Object && element.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(keys.Order());
    static double Number(JsonElement element, string key) { double value = element.GetProperty(key).GetDouble(); return double.IsFinite(value) ? value : throw new FormatException(); }
}


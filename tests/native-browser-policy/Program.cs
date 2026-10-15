// Pure policy fixtures. No Win32, UI Automation, browsers, subprocesses, or network operations.
const string profile = @"C:\fixture\system-browser-profile";
const string edge = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
const string url = "https://csagent.tsim.tech/embed/operator?source=travel-merchant-companion";
int assertions = 0;
void Check(bool pass, string name) { assertions++; if (!pass) throw new Exception(name); }
BrowserProcessProof Row(uint pid, long ticks, uint parent = 100, string? directory = null, string? app = null, string? exe = null) => new(pid, ticks, parent, exe ?? edge, $"\"{exe ?? edge}\" \"--user-data-dir={directory ?? profile}\" --app={app ?? url}");
var policy = new BrowserLaunchPolicy(profile, url, edge);
Check(BrowserLaunchPolicy.ApprovedUrl(url), "approved direct route");
foreach (string denied in new[] { "https://csagent.tsim.tech.evil/embed/operator?source=travel-merchant-companion", "http://csagent.tsim.tech/embed/operator?source=travel-merchant-companion", url + "&source=travel-merchant-companion", url + "&access_token=secret", url + "#fragment", "https://user@csagent.tsim.tech/embed/operator?source=travel-merchant-companion", "https://csagent.tsim.tech/desktop-host?source=travel-merchant-companion" }) Check(!BrowserLaunchPolicy.ApprovedUrl(denied), "URL rejected");
policy.RecordSpawn(100, 1000);
Check(policy.Accept(Row(100, 1000)), "direct spawn identity");
Check(!policy.Accept(Row(100, 2000)), "reused launch PID rejected");
Check(!policy.Accept(Row(101, 1010, directory: profile + "-other")), "profile prefix collision rejected");
Check(!policy.Accept(Row(101, 1010, exe: @"C:\fake\msedge.exe")), "executable mismatch rejected");
Check(!policy.Accept(Row(101, 1010, app: "https://other.example/app")), "app URL mismatch rejected");
Check(!policy.Accept(Row(101, 1010, parent: 999)), "same profile with unproven parent rejected");
Check(policy.Accept(Row(101, 1010)), "launch child handoff accepted");
policy.SpawnExitedTicks = 1050;
Check(policy.Accept(Row(102, 1040)), "late inspection of child born before exact spawn exit");
Check(!policy.Accept(Row(103, 1060)), "child from reused parent PID after spawn exit rejected");
Check(!policy.Accept(Row(101, 1200)), "reused successor PID rejected");
var brokerPolicy = new BrowserLaunchPolicy(profile, url, edge);
brokerPolicy.RecordBroker(Row(50, 500, parent: 1)); brokerPolicy.RecordSpawn(100, 1000);
Check(brokerPolicy.Accept(Row(50, 500, parent: 1)), "pre-snapshot broker handoff accepted");
Check(!brokerPolicy.Accept(Row(50, 501, parent: 1)), "reused snapshot broker rejected");
Check(!brokerPolicy.Accept(Row(51, 500, parent: 1)), "unrecorded background broker rejected");
Check(!brokerPolicy.Accept(Row(50, 500, parent: 1, directory: @"C:\ordinary-browser")), "profile remains required for recorded PID");
Check(!brokerPolicy.Accept(Row(50, 500, parent: 1, exe: @"C:\fake\msedge.exe")), "executable remains required for recorded PID");
Check(!policy.Matches(Row(105, 1100) with { Command = Row(105, 1100).Command + " --user-data-dir=C:\\ordinary" }), "duplicate profile denied");
Check(!policy.Matches(Row(105, 1100) with { Command = Row(105, 1100).Command + " --type=renderer" }), "renderer process denied");
var initialGeometry = new BrowserPlacementGeometry(100, 100, 960, 540, 144, 0, 44, 0, 0, true);
var firstPlan = BrowserPlacementPolicy.Decide(null, initialGeometry, false);
Check(firstPlan.Resize && firstPlan.Region && firstPlan.Show && firstPlan.Stack, "first placement initializes browser geometry and visibility");
var previousGeometry = initialGeometry;
for (int index = 1; index <= 120; index++)
{
    var moved = initialGeometry with { X = 100 + index, Y = 100 + index };
    var dragPlan = BrowserPlacementPolicy.Decide(previousGeometry, moved, false);
    Check(dragPlan.Move && !dragPlan.Resize && !dragPlan.Region && !dragPlan.Show && !dragPlan.Stack, "drag moves only without resize region show or restack");
    previousGeometry = moved;
}
var foregroundPlan = BrowserPlacementPolicy.Decide(previousGeometry, previousGeometry, true);
Check(!foregroundPlan.Move && !foregroundPlan.Resize && !foregroundPlan.Region && !foregroundPlan.Show && foregroundPlan.Stack, "foreground restacks independently of unchanged geometry");
var hidden = previousGeometry with { Visible = false };
var hidePlan = BrowserPlacementPolicy.Decide(previousGeometry, hidden, false);
Check(hidePlan.Show && hidePlan.Stack && !hidePlan.Region && !hidePlan.Resize, "leaving group changes visibility and topmost only");
Check(!BrowserPlacementPolicy.Decide(hidden, hidden, true).Stack, "hidden browser does not restack on focus");
Check(BrowserPlacementPolicy.Decide(previousGeometry, previousGeometry with { Width = 800 }, false).Region, "resize updates region");
Check(BrowserPlacementPolicy.Decide(previousGeometry, previousGeometry with { Dpi = 192 }, false).Region, "DPI change updates region");
Check(!BrowserPlacementPolicy.Decide(previousGeometry, previousGeometry, false).Region, "unchanged poll leaves region untouched");
const string componentLease = "550e8400-e29b-41d4-a716-446655440000";
string GeometryTitle(string rect = "{\"x\":40,\"y\":20,\"width\":720,\"height\":500}", bool closed = false) => BrowserComponentGeometry.Prefix + componentLease + " {\"v\":1,\"viewport\":{\"width\":800,\"height\":600,\"dpr\":1.5},\"rect\":" + rect + ",\"closed\":" + (closed ? "true" : "false") + "}";
var title = GeometryTitle();
Check(BrowserComponentGeometry.Parse(title, componentLease, 1200, 900)?.Rect == new ComponentRect(60, 30, 1080, 750), "CSS geometry maps to physical pixels at 150 percent DPI");
Check(BrowserComponentGeometry.Parse(title + " - Microsoft Edge", componentLease, 1200, 900)?.Rect != null, "known chrome title suffix accepted");
Check(BrowserComponentGeometry.Parse(title, Guid.NewGuid().ToString(), 1200, 900) == null, "geometry from another lease rejected");
Check(BrowserComponentGeometry.Parse(title, componentLease, 960, 600) == null, "stale viewport after resize rejected");
Check(BrowserComponentGeometry.Parse(title, componentLease, 960, 600, validateViewport: false)?.Rect == new ComponentRect(60, 30, 1080, 750), "independent title notification validates its envelope without requiring the old embedded viewport dimensions");
Check(BrowserComponentGeometry.Parse(title, Guid.NewGuid().ToString(), 960, 600, validateViewport: false) == null, "independent caption channel remains strictly lease scoped");
foreach (string rect in new[] { "{\"x\":-1,\"y\":0,\"width\":720,\"height\":500}", "{\"x\":40,\"y\":20,\"width\":1000,\"height\":500}", "{\"x\":40,\"y\":20,\"width\":0,\"height\":500}", "{\"x\":40,\"y\":20,\"width\":720,\"height\":500,\"secret\":1}" })
    Check(BrowserComponentGeometry.Parse(GeometryTitle(rect), componentLease, 1200, 900) == null, "out of range or unknown geometry rejected");
Check(BrowserComponentGeometry.Parse(title.Replace("\"v\":1", "\"v\":2"), componentLease, 1200, 900) == null, "unsupported protocol rejected");
Check(BrowserComponentGeometry.Parse(title.Replace("\"dpr\":1.5", "\"dpr\":1e999"), componentLease, 1200, 900) == null, "nonfinite geometry rejected");
Check(BrowserComponentGeometry.Parse(GeometryTitle("null"), componentLease, 1200, 900) == new ComponentGeometry(false, null), "pending geometry restores viewport fallback");
Check(BrowserComponentGeometry.Parse(GeometryTitle("null", true), componentLease, 1200, 900) == new ComponentGeometry(true, null), "close event has validated geometry metadata");
Check(BrowserComponentGeometry.Parse(GeometryTitle("null", true), componentLease, 960, 600) == new ComponentGeometry(true, null), "terminal close survives a pending viewport resize while remaining lease scoped");
Check(BrowserComponentGeometry.Parse(GeometryTitle(closed: true), componentLease, 960, 600) == null, "terminal close with a nonnull rectangle is rejected");
Check(BrowserComponentGeometry.Parse(title + new string(' ', 800), componentLease, 1200, 900) == null, "oversized title rejected");
var clipState = BrowserComponentGeometry.Parse(title, componentLease, 1200, 900);
var previousClipKey = BrowserComponentGeometry.StateKey(componentLease, 1200, 900, 144, clipState);
Check(previousClipKey == BrowserComponentGeometry.StateKey(componentLease, 1200, 900, 144, clipState), "unchanged title and viewport do not redraw the region");
Check(previousClipKey != BrowserComponentGeometry.StateKey(componentLease, 1350, 900, 144, clipState), "viewport resize recrops unchanged component geometry after fallback");
Check(previousClipKey != BrowserComponentGeometry.StateKey(componentLease, 1200, 900, 192, clipState), "DPI resize invalidates the component region cache");
var regionCache = new BrowserComponentRegionCache();
regionCache.MarkApplied(previousClipKey); // A has a real title-derived region.
Check(regionCache.IsCurrent(previousClipKey), "cached region A initially matches");
regionCache.Invalidate(); // Place B installs fallback while title A is stale.
Check(!regionCache.IsCurrent(BrowserComponentGeometry.StateKey(componentLease, 1350, 900, 144, clipState)), "fallback B leaves no title-derived region cached");
regionCache.Invalidate(); // Place A installs fallback while title B is stale; no poll between B and A.
Check(!regionCache.IsCurrent(previousClipKey), "fast A to B to A still reapplies the final A title despite an identical key");
regionCache.MarkApplied(previousClipKey);
Check(regionCache.IsCurrent(previousClipKey), "final A region caches normally after it has actually been applied");
for (int i = 0; i < 100; i++)
{
    var geometry = BrowserComponentGeometry.Parse(title, componentLease, 1200, 900);
    Check(geometry?.Rect?.Width == 1080 && geometry.Rect.Height == 750, "repeated 90 percent component bounds never shrink the stable viewport");
    var plan = BrowserPlacementPolicy.Decide(initialGeometry, initialGeometry, false);
    Check(!plan.Resize, "component clip updates do not resize native viewport");
}
Check(IndependentBrowserGeometry.Valid(-1920, -1080, 1200, 800), "independent order window accepts negative cross-monitor screen coordinates");
Check(IndependentBrowserGeometry.Valid(100000, -100000, 20000, 100), "independent bounds accept exact protocol limits");
foreach (var invalid in new[] { (int.MinValue, 0, 800, 600), (100001, 0, 800, 600), (0, -100001, 800, 600), (0, 0, 99, 600), (0, 0, 800, 20001) })
    Check(!IndependentBrowserGeometry.Valid(invalid.Item1, invalid.Item2, invalid.Item3, invalid.Item4), "unsafe independent restore bounds rejected without integer overflow");
Check(IndependentBrowserGeometry.WorkspaceToScreen(120, 100, 1320, 900, 0, 0, 0, 0) == (120, 100, 1200, 800), "bottom taskbar retains normal screen bounds and dimensions");
Check(IndependentBrowserGeometry.WorkspaceToScreen(120, 100, 1320, 900, 48, 40, 0, 0) == (168, 140, 1200, 800), "left and top taskbars translate workspace origin without changing restore dimensions");
Check(IndependentBrowserGeometry.WorkspaceToScreen(-1800, -800, -600, 0, -1920, -1040, -1920, -1080) == (-1800, -760, 1200, 800), "negative monitor origin uses its own work-area offset");
Console.WriteLine($"native_browser_policy: {assertions} assertions passed; no OS/browser operations");

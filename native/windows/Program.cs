using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Windows.Automation;
using System.Windows.Forms;

internal static partial class Program
{
    const string Version = "1.0";
    static readonly object OutputLock = new();
    static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static readonly List<nint> Hooks = new();
    static readonly Native.WinEventDelegate HookCallback = OnWinEvent;
    static Control dispatcher = null!;
    static nint target;
    static string? instance;
    static long generation;
    static WindowSnapshot? lastState;
    static Process? boundProcess;
    static System.Windows.Forms.Timer followTimer = null!;
    static int probeBusy;
    static nint browser;
    static string? browserProfile;
    static readonly HashSet<nint> companions = new();
    static long browserOriginalStyle;
    static string ExpectedPath = "";

    [STAThread]
    static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = Encoding.UTF8;
        try {
            var binding=NativeTargetBinding.Parse(args,Environment.ProcessPath??"");ExpectedPath=binding.Executable;
            if(binding.Owner!=0) {
                using var parent=Process.GetProcessById((int)ParentProcessId());using var owner=Process.GetProcessById(binding.Owner);using var self=Process.GetCurrentProcess();
                _=parent.SafeHandle;_=owner.SafeHandle;
                var row=ProcessRows($"ProcessId={parent.Id}").Single();
                if(row.Pid!=parent.Id||Math.Abs(row.StartedTicks-parent.StartTime.ToUniversalTime().Ticks)>10)throw new InvalidOperationException();
                NativeTargetBinding.ValidateOwner(ExpectedPath,binding.Owner,parent.MainModule?.FileName??"",row.Command,owner.MainModule?.FileName??"",owner.StartTime.ToUniversalTime().Ticks,parent.StartTime.ToUniversalTime().Ticks,self.StartTime.ToUniversalTime().Ticks);
                foreach(var path in new[]{Environment.ProcessPath!,parent.MainModule!.FileName!,ExpectedPath})NativeTargetBinding.NoRedirects(path);
            }
        }catch {Console.Error.WriteLine("native_target_binding_rejected");Environment.ExitCode=1;return;}
        Native.SetProcessDpiAwarenessContext(new nint(-4));
        dispatcher = new Control();
        _ = dispatcher.Handle;
        using var movementTimer = new System.Windows.Forms.Timer { Interval = 16 };
        followTimer = movementTimer;
        followTimer.Tick += (_, _) => { followTimer.Stop(); EmitWindowState(verifyIdentity: false); };
        using var browserMovementTimer = new System.Windows.Forms.Timer { Interval = 180 };
        browserStateTimer = browserMovementTimer;
        browserStateTimer.Tick += (_, _) => { browserStateTimer.Stop(); EmitIndependentBrowserState(); };
        using var availabilityTimer = new System.Windows.Forms.Timer { Interval = 180 };
        targetAvailableTimer = availabilityTimer;
        targetAvailableTimer.Tick += (_, _) => { targetAvailableTimer.Stop(); FlushTargetAvailable(); };
        Hooks.Add(Native.SetWinEventHook(0x0003, 0x0003, 0, HookCallback, 0, 0, 0));
        Hooks.Add(Native.SetWinEventHook(0x0016, 0x0017, 0, HookCallback, 0, 0, 0));
        Hooks.Add(Native.SetWinEventHook(0x000A, 0x000B, 0, HookCallback, 0, 0, 0));
        Hooks.Add(Native.SetWinEventHook(0x8000, 0x800B, 0, HookCallback, 0, 0, 0));
        Hooks.Add(Native.SetWinEventHook(0x800C, 0x800C, 0, HookCallback, 0, 0, 0));
        using var timer = new System.Windows.Forms.Timer { Interval = 2000 };
        timer.Tick += (_, _) => { CheckBrowser(); CheckProfileBrowserWindows(); CheckBrowserComponentGeometry(); CheckBrowserCleanup(); EmitIndependentBrowserState(); EmitWindowState(); };
        timer.Start();
        Emit("capabilities", Capabilities("not_bound"));
        _ = Task.Run(ReadCommands);
        Application.Run();
        ReleaseBrowser(true);
        foreach (var hook in Hooks.Where(h => h != 0)) Native.UnhookWinEvent(hook);
        DisposeAvailabilityProcesses();
        dispatcher.Dispose();
    }

    static async Task ReadCommands()
    {
        // Read incrementally so an untrusted line cannot allocate without a bound.
        var buffer = new char[1024];
        var line = new StringBuilder();
        bool oversized = false;
        int count;
        while ((count = await Console.In.ReadAsync(buffer)) > 0)
        {
            for (int i = 0; i < count; i++)
            {
                char value = buffer[i];
                if (value == '\n')
                {
                    var command = line.ToString();
                    bool rejected = oversized;
                    line.Clear(); oversized = false;
                    dispatcher.BeginInvoke(() => { if (rejected) Error(null, "message_too_large"); else Handle(command); });
                }
                else if (!oversized && value != '\r')
                {
                    if (line.Length >= 262144) { oversized = true; line.Clear(); }
                    else line.Append(value);
                }
            }
        }
        dispatcher.BeginInvoke(BeginAllBrowserShutdown);
    }

    static void Handle(string line)
    {
        string? requestId = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            var command = document.RootElement;
            if (command.ValueKind != JsonValueKind.Object) throw new ArgumentException();
            var allowed = new HashSet<string> { "protocolVersion", "requestId", "type", "payload" };
            if (command.EnumerateObject().Any(p => !allowed.Contains(p.Name))) throw new ArgumentException();
            if (command.GetProperty("protocolVersion").GetString() != Version) throw new ArgumentException();
            requestId = command.GetProperty("requestId").GetString();
            if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 128) throw new ArgumentException();
            string? type = command.GetProperty("type").GetString();
            JsonElement payload = command.TryGetProperty("payload", out var p) ? p : default;
            if (payload.ValueKind != JsonValueKind.Undefined && payload.ValueKind != JsonValueKind.Object) throw new ArgumentException();
            if (payload.ValueKind == JsonValueKind.Object && payload.EnumerateObject().Any(x => !new[] { "targetInstanceId", "businessProbe", "expected", "text", "processId", "profilePath", "bounds", "visible", "restack", "maximized", "close", "handles", "launchId", "startedAtTicks", "appURL", "marker", "browserKind", "profileDirectory", "bootstrapURL" }.Contains(x.Name))) throw new ArgumentException();
            if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("restack", out var restack) && restack.ValueKind != JsonValueKind.True && restack.ValueKind != JsonValueKind.False) throw new ArgumentException();
            if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("maximized", out var maximized) && maximized.ValueKind != JsonValueKind.True && maximized.ValueKind != JsonValueKind.False) throw new ArgumentException();
            switch (type)
            {
                case "listWindows": Emit("windows", new { windows = Windows() }, requestId); break;
                case "bindWindow":
                    string? requested = payload.GetProperty("targetInstanceId").GetString();
                    var window = Windows().SingleOrDefault(w => w.TargetInstanceId == requested);
                    if (window == null) { Error(requestId, "target_not_found"); break; }
                    boundProcess?.Dispose(); boundProcess = Process.GetProcessById(window.ProcessId);
                    target = new nint(window.Handle); instance = window.TargetInstanceId; generation++; lastState = null;
                    EmitWindowState(requestId); break;
                case "unbindWindow": target = 0; instance = null; boundProcess?.Dispose(); boundProcess = null; followTimer.Stop(); generation++; lastState = null; Emit("windowState", new { bound = false, reason = "unbound" }, requestId); break;
                case "probeCapabilities":
                    bool business = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("businessProbe", out var b) && b.ValueKind == JsonValueKind.True;
                    if (!business || target == 0) Emit("capabilities", Capabilities(target == 0 ? "not_bound" : "identity_and_revision_unverified"), requestId);
                    else Probe(requestId);
                    break;
                case "readDraft": DraftCommand(requestId); break;
                // Generic UIA does not prove merchant conversation identity or IME state.
                // The verified public editor adapter is the only draft mutation path.
                case "replaceDraft": Error(requestId, "verified_editor_required"); break;
                case "launchBrowser": LaunchBrowser(requestId, payload); break;
                case "adoptBrowser": AdoptBrowser(requestId, payload); break;
                case "adoptSharedBrowser": AdoptSharedBrowser(requestId, payload); break;
                case "launchProfileBrowser": LaunchProfileBrowser(requestId, payload); break;
                case "adoptProfileBrowser": AdoptProfileBrowser(requestId, payload); break;
                case "cleanupProfileBrowser": CleanupProfileBrowser(requestId, payload); break;
                case "heartbeatProfileBrowser": HeartbeatProfileBrowser(requestId, payload); break;
                case "releaseSharedBrowser": ReleaseBrowser(false); Emit("browserReleased", new { }, requestId); break;
                case "cleanupBrowserLaunch": CleanupBrowserLaunch(requestId, payload); break;
                case "placeBrowser": PlaceBrowser(requestId, payload); break;
                case "setCompanionWindows":
                    companions.Clear();
                    foreach (var h in payload.GetProperty("handles").EnumerateArray())
                    {
                        string raw = h.GetString() ?? "";
                        nint handle = new(raw.StartsWith("0x") ? Convert.ToInt64(raw[2..], 16) : long.Parse(raw));
                        Native.GetWindowThreadProcessId(handle, out uint pid);
                        if (!Native.IsWindow(handle) || pid != ParentProcessId()) throw new ArgumentException();
                        companions.Add(handle);
                        if (companions.Count > 16) throw new ArgumentException();
                    }
                    lastState = null; Emit("companionsRegistered", new { }, requestId); EmitWindowState(); break;
                case "stop": Emit("stopped", new { }, requestId); BeginAllBrowserShutdown(); break;
                default: Error(requestId, "unsupported_command"); break;
            }
        }
        catch { Error(requestId, "invalid_command"); }
    }

    static WindowInfo[] Windows()
    {
        var windows = new List<WindowInfo>();
        Native.EnumWindows((handle, _) =>
        {
            if (!Native.IsWindowVisible(handle) || Native.GetWindow(handle, 4) != 0) return true;
            try
            {
                Native.GetWindowThreadProcessId(handle, out uint pid);
                using var process = Process.GetProcessById((int)pid);
                if (!string.Equals(process.MainModule?.FileName, ExpectedPath, StringComparison.OrdinalIgnoreCase)) return true;
                string id = $"{pid}:{process.StartTime.ToUniversalTime().Ticks}:{handle.ToInt64()}";
                windows.Add(new WindowInfo(id, handle.ToInt64(), (int)pid, "旅游商家桌面版"));
            }
            catch { /* inaccessible or exited process is not a candidate */ }
            return true;
        }, 0);
        var foreground = Native.GetForegroundWindow();
        return windows.OrderByDescending(window => (nint)window.Handle == foreground)
            .ThenBy(window => Native.IsIconic((nint)window.Handle)).ToArray();
    }

    static bool StillBound(bool verifyIdentity = true)
    {
        if (target == 0) return false;
        // Hidden/minimized windows remain bound; enumeration intentionally filters visible choices.
        if (!Native.IsWindow(target)) return false;
        try
        {
            Native.GetWindowThreadProcessId(target, out uint pid);
            if (boundProcess == null || boundProcess.Id != pid || boundProcess.HasExited) return false;
            // The held process handle prevents PID reuse from passing a movement
            // check. Re-check executable/start identity on the watchdog and commands.
            return !verifyIdentity || string.Equals(boundProcess.MainModule?.FileName, ExpectedPath, StringComparison.OrdinalIgnoreCase)
                && instance == $"{pid}:{boundProcess.StartTime.ToUniversalTime().Ticks}:{target.ToInt64()}";
        }
        catch { return false; }
    }

    static void EmitWindowState(string? requestId = null, bool verifyIdentity = true)
    {
        if (target == 0) return;
        if (!StillBound(verifyIdentity))
        {
            target = 0; generation++; lastState = null; boundProcess?.Dispose(); boundProcess = null; followTimer.Stop();
            Emit("windowState", new { bound = false, targetLost = true, reason = "target_lost" }, requestId);
            instance = null;
            return;
        }
        var rect = new Native.Rect();
        string source = "dwm";
        if (Native.DwmGetWindowAttribute(target, 9, ref rect, Marshal.SizeOf<Native.Rect>()) != 0)
        { Native.GetWindowRect(target, out rect); source = "windowRect"; }
        int cloaked = 0;
        Native.DwmGetWindowAttributeInt(target, 14, out cloaked, sizeof(int));
        nint foreground = Native.GetForegroundWindow();
        PixelBounds? clientBounds = null;
        var clientOrigin = new Native.Point();
        if (Native.GetClientRect(target, out var client) && Native.ClientToScreen(target, ref clientOrigin)) clientBounds = new PixelBounds(clientOrigin.X, clientOrigin.Y, client.Right - client.Left, client.Bottom - client.Top);
        var state = new WindowSnapshot(true, new PixelBounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top), clientBounds, Native.IsWindowVisible(target) && cloaked == 0, Native.IsIconic(target), foreground == target, foreground == target || companions.Contains(foreground) || browser != 0 && foreground == browser, Native.GetDpiForWindow(target), "physical-pixels", source);
        if (requestId == null && lastState == state) return;
        lastState = state; Emit("windowState", state, requestId);
    }

    static object Capabilities(string reason, object? probe = null) => new { windowFollow = true, readMessage = false, readOrder = false, readDraft = false, writeDraft = false, reason, probe };

    static async void Probe(string requestId)
    {
        if (Interlocked.Exchange(ref probeBusy, 1) != 0) { Error(requestId, "probe_busy"); return; }
        nint handle = target; string? expectedInstance = instance; long expectedGeneration = generation;
        var task = Task.Run(() =>
        {
            var root = AutomationElement.FromHandle(handle);
            var queue = new Queue<AutomationElement>(); queue.Enqueue(root);
            var counts = new Dictionary<string, int>(); int nodes = 0;
            var clock = Stopwatch.StartNew();
            while (queue.Count > 0 && nodes < 200 && clock.ElapsedMilliseconds < 1500)
            {
                var node = queue.Dequeue(); nodes++;
                string name = node.Current.ControlType.ProgrammaticName;
                counts[name] = counts.GetValueOrDefault(name) + 1;
                var child = TreeWalker.ControlViewWalker.GetFirstChild(node);
                while (child != null && queue.Count + nodes < 200)
                { queue.Enqueue(child); child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            }
            return new { nodeCount = nodes, controlTypes = counts, bounded = true, contentRead = false, stableIdentity = false, imeObservable = false, elapsedMs = clock.ElapsedMilliseconds };
        });
        try
        {
            if (await Task.WhenAny(task, Task.Delay(2500)) != task) { Emit("capabilities", Capabilities("probe_timeout"), requestId); return; }
            var result = await task;
            if (generation != expectedGeneration || instance != expectedInstance) { Error(requestId, "stale_probe"); return; }
            Emit("capabilities", Capabilities("identity_and_revision_unverified", result), requestId);
        }
        catch { Emit("capabilities", Capabilities("uia_unavailable"), requestId); }
        finally { if (task.IsCompleted) Interlocked.Exchange(ref probeBusy, 0); else _ = task.ContinueWith(_ => Interlocked.Exchange(ref probeBusy, 0)); }
    }

    static void OnWinEvent(nint hook, uint kind, nint window, int objectId, int childId, uint threadId, uint timestamp)
    {
        if (window == browser && objectId == 0 && childId == 0)
        {
            if (kind == 0x000B) { browserStateTimer.Stop(); EmitIndependentBrowserState(); }
            else if (kind is 0x800B or 0x0016 or 0x0017 or 0x8002) QueueIndependentBrowserState();
            else if (kind == 0x8001) CheckBrowser();
        }
        // The owned profile's title retains the lease-validated close signal.
        if (kind == 0x800C && window == browser && objectId == 0 && childId == 0) { CheckBrowserComponentGeometry(); return; }
        if (target == 0) { QueueTargetAvailable(kind, window, objectId, childId); return; }
        if (kind == 3) { followTimer.Stop(); EmitWindowState(verifyIdentity: false); return; }
        // Ignore descendant accessibility objects: only the top-level window's
        // physical bounds affect placement. Collapse a burst to its latest bounds.
        if (window != target || objectId != 0 || childId != 0) return;
        if (kind == 0x800B) { if (!followTimer.Enabled) followTimer.Start(); }
        else { followTimer.Stop(); EmitWindowState(verifyIdentity: false); }
    }
    static void Error(string? requestId, string code) => Emit("error", new { code }, requestId);
    static void Emit(string type, object payload, string? requestId = null)
    {
        try { lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(new { protocolVersion = Version, requestId, eventId = Guid.NewGuid().ToString(), type, targetInstanceId = instance, accountScope = "unknown", generation, payload }, JsonOptions)); }
        catch (IOException) { if (!browserShuttingDown && !dispatcher.IsDisposed) dispatcher.BeginInvoke(BeginAllBrowserShutdown); }
    }
    sealed record WindowInfo(string TargetInstanceId, long Handle, int ProcessId, string DisplayName);
    sealed record PixelBounds(int X, int Y, int Width, int Height);
    sealed record WindowSnapshot(bool Bound, PixelBounds Bounds, PixelBounds? ClientBounds, bool Visible, bool Minimized, bool Foreground, bool GroupForeground, uint Dpi, string CoordinateSpace, string BoundsSource);
}

internal static partial class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    internal delegate bool EnumDelegate(nint hwnd, nint data);
    internal delegate void WinEventDelegate(nint hook, uint kind, nint hwnd, int idObject, int idChild, uint thread, uint timestamp);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumDelegate callback, nint data);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] internal static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(nint hwnd, ref Point point);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] internal static extern nint SetWinEventHook(uint minimum, uint maximum, nint module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(nint hook);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, ref Rect value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] internal static extern int DwmGetWindowAttributeInt(nint hwnd, uint attribute, out int value, int size);
}

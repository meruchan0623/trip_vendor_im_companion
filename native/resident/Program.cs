using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.IO.Pipes;
using System.Security.Principal;
using System.Windows.Forms;
using System.Threading.Channels;
internal static partial class Program {
 const string Version="1.0";
 static readonly JsonSerializerOptions JsonOptions=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
 static Channel<string>? output;
 static Task? outputTask;
 static Control dispatcher=null!;
 static Form? settings;
 static Label? statusLabel;
 static NotifyIcon tray=null!;
 static Process? child,boundProcess;
 static nint target;
 static string? instance;
 static long generation;
 static DateTime lastAvailable;
 static WindowSnapshot? lastState;
 static System.Windows.Forms.Timer followTimer=null!;
 static readonly Native.WinEventDelegate HookCallback=OnWinEvent;
 static readonly List<nint> Hooks=new();
 static readonly string ExpectedPath=Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"vbk-electron","旅游商家桌面版.exe"));
 static bool quitting,smoke,syncSettings,acceptance;
 static bool compactHeap=true;
 static ComboBox? languageChoice;
 static CheckBox? autoChoice,shortcutChoice;
 static readonly HashSet<string> smokeResults=new();
 static int restarts;
 static string status="正在启动轻量宿主";
 static readonly CancellationTokenSource lifetime=new();
 static string root=AppContext.BaseDirectory;
 static string pipeName="TravelMerchant.Resident."+WindowsIdentity.GetCurrent().User!.Value;
 static readonly string[] actions={"status","refreshSession","openLogin","logout","connect","disconnect","pause","resume","startClient","quit","followCustomerLanguage","updateSettings"};
 [STAThread] static void Main(string[] args){
   if(args.Contains("--compact-heap")&&args.Contains("--default-heap")){Environment.ExitCode=2;return;}
   if(args.Contains("--self-test")){ SelfTest();return; }
   acceptance=args.Contains("--acceptance");compactHeap=!args.Contains("--default-heap");args=args.Where(a=>a!="--acceptance"&&a!="--compact-heap"&&a!="--default-heap").ToArray();
   ApplicationConfiguration.Initialize();
   using var mutex=new Mutex(true,"Local\\"+pipeName,out bool first);
   if(!first){try{using var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.Out);pipe.Connect(1500);pipe.Write("OPEN_SETTINGS\n"u8);}catch{}return;}
   if(args.Length==2 && (args[0]=="--development-root"||args[0]=="--smoke-test")){root=Path.GetFullPath(args[1]);smoke=args[0]=="--smoke-test";}
   else if(args.Length!=0)return;
   dispatcher=new Control();_=dispatcher.Handle;
   tray=new NotifyIcon{Icon=SystemIcons.Application,Text="旅游商家助手（轻量宿主）",Visible=true};
   var menu=new ContextMenuStrip();
   menu.Items.Add("设置与状态",null,(_,_)=>ShowSettings());
   menu.Items.Add("登录翻译服务",null,(_,_)=>Action("openLogin"));
   menu.Items.Add("启动商家客户端",null,(_,_)=>Action("startClient"));
   menu.Items.Add("退出",null,async (_,_)=>await Shutdown());tray.ContextMenuStrip=menu;tray.DoubleClick+=(_,_)=>ShowSettings();
   followTimer=new(){Interval=40};followTimer.Tick+=(_,_)=>{followTimer.Stop();EmitWindowState(verifyIdentity:false);};
   foreach(var range in new[]{(3u,3u),(0x0016u,0x0017u),(0x8000u,0x800Bu)})Hooks.Add(Native.SetWinEventHook(range.Item1,range.Item2,0,HookCallback,0,0,0));
   using var timer=new System.Windows.Forms.Timer{Interval=2000};timer.Tick+=(_,_)=>EmitWindowState();timer.Start();
   _=ListenInstance();StartChild();Application.Run();
   lifetime.Cancel();tray.Visible=false;tray.Dispose();foreach(var hook in Hooks.Where(h=>h!=0))Native.UnhookWinEvent(hook);boundProcess?.Dispose();child?.Dispose();dispatcher.Dispose();
 }
 static void OnWinEvent(nint hook,uint kind,nint window,int objectId,int childId,uint thread,uint time){
   if(target==0){if(kind is 0x8000 or 0x8002 && objectId==0 && childId==0 && window!=0 && DateTime.UtcNow-lastAvailable>TimeSpan.FromSeconds(2)&&Native.IsWindowVisible(window)&&Native.GetWindow(window,4)==0){
    var name=new StringBuilder(64);Native.GetClassName(window,name,name.Capacity);
    if(name.ToString()=="Chrome_WidgetWin_1")try{Native.GetWindowThreadProcessId(window,out uint pid);using var process=Process.GetProcessById((int)pid);if(string.Equals(process.MainModule?.FileName,ExpectedPath,StringComparison.OrdinalIgnoreCase)){lastAvailable=DateTime.UtcNow;Emit("targetAvailable",new{});}}catch{}
   }return;}
   if(kind==3){EmitWindowState(verifyIdentity:false);return;}
   if(window!=target||objectId!=0||childId!=0)return;
   if(!followTimer.Enabled)followTimer.Start();
 }
 static void Emit(string type,object payload,string? requestId=null){Send(new{protocolVersion=Version,type,payload,requestId,targetInstanceId=instance,generation});}
 static void Error(string? id,string code)=>Emit("error",new{code},id);
 static void Send(object value){
  if(quitting)return;
  string line=JsonSerializer.Serialize(value,JsonOptions);
  if(line.Length>65536||output?.Writer.TryWrite(line)!=true){SetStatus("后台连接繁忙或已断开");if(child!=null)_=Shutdown();}
 }
 static async Task WriteOutput(Process owned,Channel<string> queue){
  try{await foreach(string line in queue.Reader.ReadAllAsync())await owned.StandardInput.WriteLineAsync(line).WaitAsync(TimeSpan.FromSeconds(3));}
  catch{if(!dispatcher.IsDisposed)dispatcher.BeginInvoke(()=>{if(child==owned&&!quitting){SetStatus("后台通信超时");_=Shutdown();}});}
 }
 static void Action(string action,object? options=null){if(!actions.Contains(action))return;object payload=action=="updateSettings"?new{action,options}:new{action};Send(new{protocolVersion=Version,type="hostAction",requestId=smoke?action:Guid.NewGuid().ToString(),payload});}
 static void SetStatus(string value){status=value;if(statusLabel!=null&&!statusLabel.IsDisposed)statusLabel.Text=value;}
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
        var state = new WindowSnapshot(true, new PixelBounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top), clientBounds, Native.IsWindowVisible(target) && cloaked == 0, Native.IsIconic(target), foreground == target, foreground == target || (settings != null && foreground == settings.Handle), Native.GetDpiForWindow(target), "physical-pixels", source);
        if (requestId == null && lastState == state) return;
        lastState = state; Emit("windowState", state, requestId);
    }


 sealed record WindowInfo(string TargetInstanceId,long Handle,int ProcessId,string DisplayName);
 sealed record PixelBounds(int X,int Y,int Width,int Height);
 sealed record WindowSnapshot(bool Bound,PixelBounds Bounds,PixelBounds? ClientBounds,bool Visible,bool Minimized,bool Foreground,bool GroupForeground,uint Dpi,string CoordinateSpace,string BoundsSource);
}
internal static partial class Native
{
    [DllImport("user32.dll")] internal static extern bool ShowWindow(nint hwnd,int command);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern int GetClassName(nint hwnd,StringBuilder name,int max);
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

using System.Diagnostics;

namespace TripVendorInstaller;

sealed record ClientProcess(int Id,string Name,string? Image,long? Started);
interface IClientProcesses {
    long ElapsedMilliseconds { get; }
    IReadOnlyList<ClientProcess> Snapshot();
    bool Terminate(ClientProcess expected);
    void Pause(int milliseconds);
}

sealed class WindowsClientProcesses : IClientProcesses {
    readonly Stopwatch clock=Stopwatch.StartNew();
    public long ElapsedMilliseconds=>clock.ElapsedMilliseconds;
    internal static void ValidateIdentity(ClientProcess expected,ClientProcess actual){
        if(actual.Id!=expected.Id||actual.Started!=expected.Started||actual.Started==null||actual.Image==null||!string.Equals(actual.Image,expected.Image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PROCESS_IDENTITY_CHANGED: "+expected.Id);
    }
    public IReadOnlyList<ClientProcess> Snapshot(){
        var rows=new List<ClientProcess>();
        foreach(var process in Process.GetProcesses())using(process){
            string name;try{name=process.ProcessName;}catch{continue;}
            string? image=null;long? started=null;
            try{started=process.StartTime.ToUniversalTime().Ticks;}catch{}
            try{image=process.MainModule?.FileName;}catch{}
            try{if(process.HasExited)continue;}catch{}
            rows.Add(new(process.Id,name,image,started));
        }
        return rows;
    }
    public bool Terminate(ClientProcess expected){
        Process process;try{process=Process.GetProcessById(expected.Id);}catch(ArgumentException){return true;}
        using(process){
            ClientProcess actual;
            try{
                // Pin this process object before validation; never terminate a replacement PID or its tree.
                _=process.Handle;
                if(process.HasExited)return true;
                actual=new(process.Id,process.ProcessName,process.MainModule?.FileName,process.StartTime.ToUniversalTime().Ticks);
            }catch(Exception error)when(error is InvalidOperationException or System.ComponentModel.Win32Exception){
                // Exit can race identity reads. Retry a fresh snapshot without killing an unverified process.
                return false;
            }
            if(actual.Image==null)return false;
            ValidateIdentity(expected,actual);
            try{process.Kill(entireProcessTree:false);}
            catch(InvalidOperationException){if(process.HasExited)return true;throw;}
            catch(System.ComponentModel.Win32Exception){return false;}
            // Kill is asynchronous. The guard, with its single overall deadline, verifies completion.
            return true;
        }
    }
    public void Pause(int milliseconds)=>Thread.Sleep(milliseconds);
}

sealed class ClientProcessGuard(string officialRoot,string localAppData,IClientProcesses backend,Action<string> log,string? installerImage=null,int? installerProcessId=null) {
    static bool IsSuspect(string name)=>name.Contains("vbk",StringComparison.OrdinalIgnoreCase)||name.Contains("旅游商家",StringComparison.Ordinal)||name.Equals("TravelMerchant.WindowHelper",StringComparison.OrdinalIgnoreCase);
    static string Full(string path)=>Path.GetFullPath(path);
    bool Under(string path,string root)=>path.StartsWith(Full(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    bool IsInstaller(ClientProcess process){
        // The running installer and its UAC parent share this exact image. Names are never exclusions.
        if(process.Id==(installerProcessId??Environment.ProcessId))return true;
        return installerImage!=null&&process.Started!=null&&process.Image is string path&&
            string.Equals(Full(path),Full(installerImage),StringComparison.OrdinalIgnoreCase);
    }
    bool Related(ClientProcess process)=>!IsInstaller(process)&&(IsSuspect(process.Name)||process.Image is string path&&(Under(Full(path),officialRoot)||path.Contains(@"vbk-electron-updater\pending",StringComparison.OrdinalIgnoreCase)));
    bool Allowed(ClientProcess process){
        if(process.Image is not string path||process.Started==null)return false;
        path=Full(path);
        var main=Path.Combine(officialRoot,"旅游商家桌面版.exe");
        var helper=Path.Combine(officialRoot,"resources","TripVendorCompanion","旅游商家助手.exe");
        var nativeHelper=Path.Combine(officialRoot,"resources","TripVendorCompanion","resources","native","windows","TravelMerchant.WindowHelper.exe");
        var pending=Path.Combine(localAppData,"vbk-electron-updater","pending");
        var file=Path.GetFileName(path);
        var approved=path.Equals(main,StringComparison.OrdinalIgnoreCase)||path.Equals(helper,StringComparison.OrdinalIgnoreCase)||path.Equals(nativeHelper,StringComparison.OrdinalIgnoreCase)||
            (string.Equals(Path.GetDirectoryName(path),Full(pending),StringComparison.OrdinalIgnoreCase)&&file.StartsWith("旅游商家桌面版_win_",StringComparison.OrdinalIgnoreCase)&&file.EndsWith(".exe",StringComparison.OrdinalIgnoreCase));
        if(!approved)return false;
        // Reject junctions/symlinks in every existing component, including the executable itself.
        for(string? current=path;current!=null;current=Path.GetDirectoryName(current)){
            if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)return false;
        }
        return true;
    }
    List<ClientProcess> RelatedProcesses()=>backend.Snapshot().Where(Related).ToList();
    public void AssertIdle(){
        var active=RelatedProcesses();
        if(active.Count>0)throw new InvalidOperationException("QUIT_VENDOR_AND_COMPANION_FIRST: 请先完全退出客户端、助手和官方更新程序："+string.Join("、",active.Select(p=>p.Name+" (PID "+p.Id+")")));
    }
    public void ForceExit(){
        const int timeoutMilliseconds=60000,interval=250,quietMilliseconds=5000;
        var start=backend.ElapsedMilliseconds;long? quietSince=null;long nextProgress=5000;
        var terminated=new HashSet<(int,long?)>();
        List<ClientProcess> unresolved=[];
        log("正在退出客户端与助手；最多等待 60 秒，并连续确认 5 秒没有相关进程重新启动……");
        while(backend.ElapsedMilliseconds-start<timeoutMilliseconds){
            var active=RelatedProcesses();
            var elapsed=backend.ElapsedMilliseconds-start;
            if(elapsed>=timeoutMilliseconds)break;
            if(active.Count==0){
                unresolved=[];quietSince??=elapsed;
                if(elapsed-quietSince>=quietMilliseconds){log("已确认客户端、助手与更新程序全部退出，且连续 5 秒未重新启动。");return;}
            }else{
                quietSince=null;unresolved=[];
                // Unreadable exit-time identities may disappear or become readable on the next scan.
                // A readable foreign image still fails immediately. Never kill any set with unknown identities.
                foreach(var process in active){
                    if(process.Image==null||process.Started==null){unresolved.Add(process);continue;}
                    if(!Allowed(process))throw new InvalidOperationException("PROCESS_FORCE_EXIT_REFUSED: 无法确认进程属于允许的客户端路径，请手动退出："+process.Name+" (PID "+process.Id+")");
                }
                if(unresolved.Count==0)foreach(var process in active)if(!terminated.Contains((process.Id,process.Started))){
                    if(backend.ElapsedMilliseconds-start>=timeoutMilliseconds)break;
                    log("请求强制退出："+process.Name+" (PID "+process.Id+") "+process.Image);
                    if(backend.Terminate(process))terminated.Add((process.Id,process.Started));
                }
            }
            if(elapsed>=nextProgress){log("等待完全退出：已等待 "+elapsed/1000+" 秒，相关进程 "+active.Count+" 个"+(unresolved.Count>0?"，正在等待退出中的进程身份恢复或消失。":"。"));nextProgress=elapsed+5000;}
            var remaining=timeoutMilliseconds-(backend.ElapsedMilliseconds-start);
            if(remaining>0)backend.Pause((int)Math.Min(interval,remaining));
        }
        if(unresolved.Count>0)throw new InvalidOperationException("PROCESS_FORCE_EXIT_REFUSED: 等待 60 秒后仍无法核验相关进程，请手动完全退出："+string.Join("、",unresolved.Select(p=>p.Name+" (PID "+p.Id+")")));
        throw new InvalidOperationException("PROCESS_EXIT_NOT_STABLE: 等待 60 秒后，客户端、助手或更新程序仍未连续 5 秒完全退出，请手动完全退出后重试。");
    }
}

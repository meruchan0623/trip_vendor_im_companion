using System.Diagnostics;

namespace TripVendorInstaller;

sealed record ClientProcess(int Id,string Name,string? Image,long? Started);
interface IClientProcesses {
    IReadOnlyList<ClientProcess> Snapshot();
    void Terminate(ClientProcess expected);
    void Pause(int milliseconds);
}

sealed class WindowsClientProcesses : IClientProcesses {
    internal static void ValidateIdentity(ClientProcess expected,ClientProcess actual){
        if(actual.Id!=expected.Id||actual.Started!=expected.Started||actual.Started==null||actual.Image==null||!string.Equals(actual.Image,expected.Image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PROCESS_IDENTITY_CHANGED: "+expected.Id);
    }
    public IReadOnlyList<ClientProcess> Snapshot(){
        var rows=new List<ClientProcess>();
        foreach(var process in Process.GetProcesses())using(process){
            string name;try{name=process.ProcessName;}catch{continue;}
            try{rows.Add(new(process.Id,name,process.MainModule?.FileName,process.StartTime.ToUniversalTime().Ticks));}
            catch{try{if(!process.HasExited)rows.Add(new(process.Id,name,null,null));}catch{rows.Add(new(process.Id,name,null,null));}}
        }
        return rows;
    }
    public void Terminate(ClientProcess expected){
        Process process;try{process=Process.GetProcessById(expected.Id);}catch(ArgumentException){return;}
        using(process){
            try{
                // Pin this process object before validation; never terminate a replacement PID or its tree.
                _=process.Handle;
                if(process.HasExited)return;
                ValidateIdentity(expected,new(process.Id,process.ProcessName,process.MainModule?.FileName,process.StartTime.ToUniversalTime().Ticks));
                process.Kill(entireProcessTree:false);
            }catch(InvalidOperationException){if(process.HasExited)return;throw;}
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
        const int attempts=40,interval=250;
        var terminated=new HashSet<(int,long?)>();
        for(var attempt=0;attempt<attempts;attempt++){
            var active=RelatedProcesses();if(active.Count==0){log("已确认客户端、助手与更新程序全部退出。");return;}
            // Validate the whole set before the first kill, so inaccessible/foreign names fail closed.
            foreach(var process in active)if(!Allowed(process))throw new InvalidOperationException("PROCESS_FORCE_EXIT_REFUSED: 无法确认进程属于允许的客户端路径，请手动退出："+process.Name+" (PID "+process.Id+")");
            foreach(var process in active)if(terminated.Add((process.Id,process.Started))){log("强制退出："+process.Name+" (PID "+process.Id+") "+process.Image);backend.Terminate(process);}
            backend.Pause(interval);
        }
        AssertIdle();
    }
}

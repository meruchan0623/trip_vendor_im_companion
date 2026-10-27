using System.Diagnostics;
using TripVendorInstaller;

if(args.Length==3&&args[0]=="--log-writer"){
    for(var i=0;i<80;i++)InstallerLog.Append(args[1],args[2]+":"+i);
    return;
}
var root=Path.Combine(Path.GetTempPath(),"installer-exit-tests-"+Guid.NewGuid());
Directory.CreateDirectory(root);
var image=Path.Combine(root,"旅游商家桌面版.exe");File.WriteAllText(image,"");
var helperImage=Path.Combine(root,"resources","TripVendorCompanion","旅游商家助手.exe");Directory.CreateDirectory(Path.GetDirectoryName(helperImage)!);File.WriteAllText(helperImage,"");
try{
    void Run(string name,Func<FakeProcesses,IReadOnlyList<ClientProcess>> snapshot,string? error,int elapsed,int kills,Func<FakeProcesses,ClientProcess,bool>? terminate=null){
        var backend=new FakeProcesses(snapshot,terminate);
        var guard=new ClientProcessGuard(root,root,backend,_=>{});
        string? failure=null;
        try{guard.ForceExit();}catch(InvalidOperationException e){failure=e.Message.Split(':')[0];}
        if(failure!=error||backend.Elapsed!=elapsed||backend.Killed.Count!=kills)throw new Exception(name+" failed: error="+failure+" elapsed="+backend.Elapsed+" kills="+backend.Killed.Count);
        Console.WriteLine("PASS "+name+" elapsed="+backend.Elapsed+" kills="+backend.Killed.Count);
    }
    ClientProcess first=new(123,"旅游商家桌面版",image,1),restarted=first with{Started=2};
    ClientProcess unreadable=first with{Image=null},foreign=first with{Image=Path.Combine(root,"foreign.exe")};
    Run("already idle still waits five seconds",_=>[],null,5000,0);
    Run("asynchronous exit beyond old per-process timeout",b=>b.Elapsed<8000?[first]:[],null,13000,1);
    Run("restart after former two-second quiet window resets wait",b=>b.Elapsed<250?[first]:b.Elapsed>=3500&&b.Elapsed<4000?[restarted]:[],null,9000,2);
    Run("assistant restarts after main exits",b=>b.Elapsed<250?[first]:b.Elapsed>=3500&&b.Elapsed<6000?[new(456,"旅游商家助手",helperImage,3)]:[],null,11000,2);
    Run("persistent process refuses injection",_=>[first],"PROCESS_EXIT_NOT_STABLE",60000,1);
    Run("late disappearance cannot bypass quiet window",b=>b.Elapsed<57500?[first]:[],"PROCESS_EXIT_NOT_STABLE",60000,1);
    Run("unreadable exiting process may disappear without kill",b=>b.Elapsed<3000?[unreadable]:[],null,8000,0);
    Run("unreadable identity can recover before safe kill",b=>b.Elapsed<2000?[unreadable]:b.Elapsed<3000?[first]:[],null,8000,1);
    Run("persistent unknown identity blocks all kills and injection",_=>[first,unreadable with{Id=456}],"PROCESS_FORCE_EXIT_REFUSED",60000,0);
    Run("readable foreign image refuses immediately",_=>[first,foreign with{Id=456}],"PROCESS_FORCE_EXIT_REFUSED",0,0);
    Run("identity unreadable between snapshot and kill retries safely",b=>b.Elapsed<3000?[first]:[],null,8000,1,(b,_)=>b.Elapsed>=2000);
    Run("snapshot time counts against overall deadline",b=>{b.Elapsed+=30000;return [];},"PROCESS_EXIT_NOT_STABLE",60250,0);
    Run("termination time counts against deadline before killing next process",b=>[first,first with{Id=456}],"PROCESS_EXIT_NOT_STABLE",60000,1,(b,_)=>{b.Elapsed+=60000;return true;});
    try{WindowsClientProcesses.ValidateIdentity(first,restarted);throw new Exception("PID reuse was accepted");}catch(InvalidOperationException e)when(e.Message.StartsWith("PROCESS_IDENTITY_CHANGED:")){Console.WriteLine("PASS reused PID identity is rejected before kill");}

    var log=Path.Combine(root,"concurrent.log");File.WriteAllText(log,"");
    using(var readerHandle=new FileStream(log,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))InstallerLog.Append(log,"shared-reader");
    var children=Enumerable.Range(0,3).Select(index=>{
        var info=new ProcessStartInfo(Environment.ProcessPath!){UseShellExecute=false};
        foreach(var value in new[]{"--log-writer",log,"writer"+index})info.ArgumentList.Add(value);
        return Process.Start(info)??throw new Exception("test writer did not start");
    }).ToArray();
    try{
        var logWait=Stopwatch.StartNew();
        while(children.Any(child=>!child.HasExited)){if(logWait.ElapsedMilliseconds>15000)throw new Exception("concurrent log writers timed out");_=InstallerLog.Read(log);Thread.Sleep(1);}
        foreach(var child in children)if(child.ExitCode!=0)throw new Exception("test writer failed");
    }finally{foreach(var child in children)child.Dispose();}
    var lines=InstallerLog.Read(log).Split(Environment.NewLine,StringSplitOptions.RemoveEmptyEntries);
    if(lines.Length!=241||lines.Distinct().Count()!=241||Directory.GetFiles(root,"*.fallback.log").Length!=0)throw new Exception("concurrent log writes were lost or interleaved");
    Console.WriteLine("PASS three process writers and live shared reader preserve all 241 lines");

    var locked=Path.Combine(root,"locked.log");
    using(var exclusive=new FileStream(locked,FileMode.Create,FileAccess.ReadWrite,FileShare.None))InstallerLog.Append(locked,"失败: ORIGINAL_CORE_ERROR");
    var fallback=InstallerLog.Read(locked+"."+Environment.ProcessId+".fallback.log");
    if(!fallback.Contains("失败: ORIGINAL_CORE_ERROR")||!fallback.Contains("INSTALLER_LOG_WRITE_FAILED"))throw new Exception("original operation failure was lost");
    Console.WriteLine("PASS log write failure does not throw and preserves original operation error in fallback");
}finally{Directory.Delete(root,true);}

sealed class FakeProcesses(Func<FakeProcesses,IReadOnlyList<ClientProcess>> snapshot,Func<FakeProcesses,ClientProcess,bool>? terminate):IClientProcesses{
    public long Elapsed;public List<ClientProcess> Killed=[];
    public long ElapsedMilliseconds=>Elapsed;
    public IReadOnlyList<ClientProcess> Snapshot()=>snapshot(this);
    public bool Terminate(ClientProcess expected){if(terminate!=null&&!terminate(this,expected))return false;Killed.Add(expected);return true;}
    public void Pause(int milliseconds){if(milliseconds<=0)throw new Exception("invalid pause");Elapsed+=milliseconds;}
}

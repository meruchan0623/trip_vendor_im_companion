using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace TripVendorInstaller;

public sealed record Manifest(string Kind, string Version, string Executable, string ExecutableVersion,
    string ExecutableSha256, string OriginalAsarSha256, string PatchedAsarSha256,
    Dictionary<string,string> VendorFiles, Dictionary<string,string> PayloadFiles,
    bool Dynamic = false, string? BootstrapSha256 = null, bool RebaseOfficialUpdate = false);
public sealed record Receipt(Manifest Manifest, string InstalledAt);
public sealed record Transaction(string Operation, string BeforeSha256, string AfterSha256, Receipt? BeforeReceipt, bool HadPayload, bool Committed = false);
public sealed record Migration(string Id,string NewOriginalSha256,string NewExecutableSha256,bool HadPayload=true);
public sealed class Engine {
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase, WriteIndented=true, PropertyNameCaseInsensitive=true };
    readonly string root, state, payload, asar;
    readonly Manifest manifest;
    readonly Action assertIdle;
    readonly Action<string> log;
    readonly Action<string>? fault;
    public Engine(string root, Manifest manifest, Action assertIdle, Action<string> log, Action<string>? fault = null) {
        this.root=Path.GetFullPath(root);this.manifest=manifest;this.assertIdle=assertIdle;this.log=log;this.fault=fault;
        state=Path.Combine(this.root,"resources","TripVendorCompanion.Install");
        payload=Path.Combine(this.root,"resources","TripVendorCompanion");asar=Path.Combine(this.root,"resources","app.asar");
    }
    public static string Hash(string file) { using var input=File.OpenRead(file);return Convert.ToHexStringLower(SHA256.HashData(input)); }
    static void Check(bool condition,string code) { if(!condition)throw new InvalidOperationException(code); }
    public static string Child(string parent,string relative) {
        Check(!Path.IsPathRooted(relative)&&!relative.Contains(':')&&!relative.Split('/','\\').Any(p=>p is ".." or ""),"UNSAFE_RELATIVE_PATH");
        var result=Path.GetFullPath(Path.Combine(parent,relative));Check(result.StartsWith(Path.GetFullPath(parent)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase),"UNSAFE_PATH");return result;
    }
    public static void NoLinks(string path) {
        var info=Directory.Exists(path)?(FileSystemInfo)new DirectoryInfo(path):new FileInfo(path);
        for(FileSystemInfo? current=info;current!=null;current=current is DirectoryInfo d?d.Parent:((FileInfo)current).Directory)
            if(current.Exists)Check((current.Attributes&FileAttributes.ReparsePoint)==0,"REPARSE_POINT_REJECTED");
        if(Directory.Exists(path))foreach(var child in Directory.EnumerateFileSystemEntries(path)){Check((File.GetAttributes(child)&FileAttributes.ReparsePoint)==0,"REPARSE_POINT_REJECTED");if(Directory.Exists(child))NoLinks(child);}
    }
    static void WriteJson<T>(string path,T value) {
        var temporary=path+".new";using(var stream=new FileStream(temporary,FileMode.Create,FileAccess.Write,FileShare.None)){JsonSerializer.Serialize(stream,value,Json);stream.Flush(true);}File.Move(temporary,path,true);
    }
    T Read<T>(string name)=>JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(state,name)),Json)??throw new InvalidDataException("INVALID_INSTALL_STATE");
    Receipt? Current()=>File.Exists(Path.Combine(state,"receipt.json"))?Read<Receipt>("receipt.json"):null;
    void VerifyVendor(string expected) {
        Check(Hash(Child(root,manifest.Executable))==manifest.ExecutableSha256,"UNSUPPORTED_OFFICIAL_EXE");
        Check(FileVersionInfo.GetVersionInfo(Child(root,manifest.Executable)).FileVersion==manifest.ExecutableVersion,"UNSUPPORTED_OFFICIAL_VERSION");
        Check(Hash(asar)==expected,"OFFICIAL_UPDATE_OR_RESOURCE_DRIFT");
        foreach(var item in manifest.VendorFiles)Check(Hash(Child(root,item.Key))==item.Value,"OFFICIAL_PAGE_DRIFT: "+item.Key);
    }
    void VerifyPayload(string folder,Manifest m) {
        NoLinks(folder);
        var files=Directory.GetFiles(folder,"*",SearchOption.AllDirectories).Select(p=>Path.GetRelativePath(folder,p).Replace('\\','/')).Order().ToArray();
        Check(files.SequenceEqual(m.PayloadFiles.Keys.Order()),"PAYLOAD_FILE_SET_MISMATCH");
        foreach(var item in m.PayloadFiles)Check(Hash(Child(folder,item.Key))==item.Value,"PAYLOAD_HASH_MISMATCH: "+item.Key);
    }
    void Point(string phase){log(phase);fault?.Invoke(phase);}
    void RefuseDowngrade(Receipt? installed) {
        if(InstallerVersions.TryCompare(installed?.Manifest.Version,manifest.Version,out var comparison)&&comparison>0)
            throw new InvalidOperationException("ASSISTANT_DOWNGRADE_REFUSED：已安装助手 "+installed!.Manifest.Version+" 高于本安装包 "+manifest.Version+"；请使用同版或更新安装包。");
    }
    public void Execute(string operation, string? packageZip) {
        Check(operation is "install" or "uninstall" or "recover" or "check","INVALID_OPERATION");
        NoLinks(root);assertIdle();
        if(operation=="check"){
            Check(!File.Exists(Path.Combine(state,"pending.json")),"RECOVERY_REQUIRED");var existing=Current();
            VerifyVendor(existing?.Manifest.PatchedAsarSha256??manifest.OriginalAsarSha256);
            if(existing!=null)VerifyPayload(payload,existing.Manifest);else Check(!Directory.Exists(payload),"UNKNOWN_EXISTING_PAYLOAD");
            log(existing==null?"compatible":"installed");return;
        }
        using var installLock=new FileStream(Path.Combine(root,"resources","TripVendorCompanion.install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        if(operation=="install"){
            // An uncommitted receipt may describe the interrupted new package, not the
            // installation recovery will retain. Preserve existing rollback semantics.
            var pending=File.Exists(Path.Combine(state,"pending.json"))?Read<Transaction>("pending.json"):null;
            RefuseDowngrade(pending is {Committed:false}?pending.BeforeReceipt:Current());
        }
        RecoverMigration();
        var stale=Current();
        var orphanedBackup=stale==null&&File.Exists(Path.Combine(state,"original.asar"))&&Hash(Path.Combine(state,"original.asar"))!=manifest.OriginalAsarSha256;
        if(operation=="install"&&manifest.Dynamic&&(manifest.RebaseOfficialUpdate&&stale!=null&&(stale.Manifest.OriginalAsarSha256!=manifest.OriginalAsarSha256||stale.Manifest.ExecutableSha256!=manifest.ExecutableSha256)||orphanedBackup)){
            Check(!File.Exists(Path.Combine(state,"pending.json")),"RECOVERY_REQUIRED_BEFORE_OFFICIAL_REBASE");
            VerifyVendor(manifest.OriginalAsarSha256);if(stale!=null)VerifyPayload(payload,stale.Manifest);else Check(!Directory.Exists(payload),"UNKNOWN_EXISTING_PAYLOAD");assertIdle();
            WriteJson(MigrationPath,new Migration(Guid.NewGuid().ToString("N"),manifest.OriginalAsarSha256,manifest.ExecutableSha256,stale!=null));Point("migration-journal-written");RecoverMigration();
        }
        Directory.CreateDirectory(state);NoLinks(state);
        Recover();
        if(operation=="recover")return;
        var old=Current();var expected=old?.Manifest.PatchedAsarSha256??manifest.OriginalAsarSha256;
        if(operation=="install")RefuseDowngrade(old);
        VerifyVendor(expected);
        if(old!=null){Check(old.Manifest.ExecutableSha256==manifest.ExecutableSha256&&old.Manifest.OriginalAsarSha256==manifest.OriginalAsarSha256,"INSTALL_RECEIPT_BUILD_MISMATCH");VerifyPayload(payload,old.Manifest);}
        else Check(!Directory.Exists(payload),"UNKNOWN_EXISTING_PAYLOAD");
        if(operation=="check"){log(old==null?"compatible":"installed");return;}
        if(operation=="uninstall"&&old==null){log("already-uninstalled");return;}
        if(operation=="install"&&old!=null&&old.Manifest.Version==manifest.Version&&old.Manifest.PatchedAsarSha256==manifest.PatchedAsarSha256&&old.Manifest.PayloadFiles.OrderBy(p=>p.Key).SequenceEqual(manifest.PayloadFiles.OrderBy(p=>p.Key))){log("already-installed");return;}
        var original=Path.Combine(state,"original.asar");
        if(!File.Exists(original)){
            Check(old==null,"ORIGINAL_BACKUP_MISSING");var draft=original+".new";
            using(var source=File.OpenRead(asar))using(var output=new FileStream(draft,FileMode.Create,FileAccess.Write,FileShare.None)){source.CopyTo(output);output.Flush(true);}
            Check(Hash(draft)==manifest.OriginalAsarSha256,"ORIGINAL_BACKUP_HASH_MISMATCH");File.Move(draft,original);
        }
        Check(Hash(original)==manifest.OriginalAsarSha256,"ORIGINAL_BACKUP_HASH_MISMATCH");
        var stage=Path.Combine(state,"stage");if(Directory.Exists(stage))Directory.Delete(stage,true);Directory.CreateDirectory(stage);
        if(operation=="install") {
            Check(packageZip!=null,"MISSING_PAYLOAD");
            using var zip=ZipFile.OpenRead(packageZip!);
            foreach(var entry in zip.Entries) {
                if(entry.FullName.EndsWith('/'))continue;
                var destination=Child(stage,entry.FullName);Directory.CreateDirectory(Path.GetDirectoryName(destination)!);entry.ExtractToFile(destination,false);
            }
            Check(Hash(Path.Combine(stage,"patched.asar"))==manifest.PatchedAsarSha256,"PATCHED_ASAR_HASH_MISMATCH");
            VerifyPayload(Path.Combine(stage,"helper"),manifest);
        }
        Point("prepared");assertIdle();VerifyVendor(expected);
        File.Copy(asar,Path.Combine(state,"rollback.asar"),true);
        var tx=new Transaction(operation,expected,operation=="install"?manifest.PatchedAsarSha256:manifest.OriginalAsarSha256,old,old!=null);
        WriteJson(Path.Combine(state,"pending.json"),tx);Point("journal-written");
        try {
            var previous=Path.Combine(state,"previous-helper");Check(!Directory.Exists(previous),"RECOVERY_PAYLOAD_REMAINS");
            if(old!=null)Directory.Move(payload,previous);Point("old-payload-moved");
            if(operation=="install")Directory.Move(Path.Combine(stage,"helper"),payload);Point("payload-placed");
            // File.Replace is atomic on the same volume and never removes our only recovery copy.
            var replacement=Path.Combine(state,"replacement.asar");File.Copy(operation=="install"?Path.Combine(stage,"patched.asar"):original,replacement,true);
            File.Replace(replacement,asar,null);Point("asar-replaced");
            Check(Hash(asar)==tx.AfterSha256,"INSTALLED_ASAR_HASH_MISMATCH");
            if(operation=="install"){VerifyPayload(payload,manifest);WriteJson(Path.Combine(state,"receipt.json"),new Receipt(manifest,DateTimeOffset.UtcNow.ToString("O")));}
            else File.Delete(Path.Combine(state,"receipt.json"));
            Point("receipt-written");WriteJson(Path.Combine(state,"pending.json"),tx with {Committed=true});Point("committed");
            Finish();log(operation=="install"?"installed":"uninstalled");
        } catch { Recover();throw; }
    }
    string MigrationPath=>Path.Combine(root,"resources","TripVendorCompanion.migration.json");
    void RecoverMigration(){
        if(!File.Exists(MigrationPath))return;
        var tx=JsonSerializer.Deserialize<Migration>(File.ReadAllText(MigrationPath),Json)??throw new InvalidDataException("INVALID_MIGRATION");
        Check(System.Text.RegularExpressions.Regex.IsMatch(tx.Id,"^[a-f0-9]{32}$")&&Hash(asar)==tx.NewOriginalSha256&&Hash(Child(root,manifest.Executable))==tx.NewExecutableSha256,"MIGRATION_REFUSES_VENDOR_DRIFT");
        var archive=Path.Combine(root,"resources","TripVendorCompanion.Archives",tx.Id);Directory.CreateDirectory(archive);
        var oldState=Path.Combine(archive,"state");var oldPayload=Path.Combine(archive,"helper");
        Check(!(Directory.Exists(state)&&Directory.Exists(oldState)),"MIGRATION_STATE_CONFLICT");
        if(Directory.Exists(state))Directory.Move(state,oldState);Point("migration-state-archived");
        Check(Directory.Exists(oldState),"MIGRATION_STATE_MISSING");
        Check(!(Directory.Exists(payload)&&Directory.Exists(oldPayload)),"MIGRATION_PAYLOAD_CONFLICT");
        if(Directory.Exists(payload))Directory.Move(payload,oldPayload);Point("migration-payload-archived");
        Check(!tx.HadPayload||Directory.Exists(oldPayload),"MIGRATION_PAYLOAD_MISSING");File.Delete(MigrationPath);log("已归档旧版助手与原版备份；本次将仅备份并接入新版官方资源。");
    }
    void Finish(){
        var previous=Path.Combine(state,"previous-helper");if(Directory.Exists(previous))Directory.Delete(previous,true);
        var stage=Path.Combine(state,"stage");if(Directory.Exists(stage))Directory.Delete(stage,true);
        File.Delete(Path.Combine(state,"pending.json"));File.Delete(Path.Combine(state,"rollback.asar"));
    }
    void Recover(){
        if(!File.Exists(Path.Combine(state,"pending.json")))return;
        var tx=Read<Transaction>("pending.json");Check(tx.Operation is "install" or "uninstall","INVALID_TRANSACTION");
        var prior=tx.BeforeReceipt;
        Check(tx.BeforeSha256==(prior?.Manifest.PatchedAsarSha256??manifest.OriginalAsarSha256)&&
            (tx.Operation=="install"?System.Text.RegularExpressions.Regex.IsMatch(tx.AfterSha256??"","^[a-f0-9]{64}$"):tx.AfterSha256==manifest.OriginalAsarSha256)&&
            tx.HadPayload==(prior!=null)&&
            (prior==null||prior.Manifest.ExecutableSha256==manifest.ExecutableSha256&&prior.Manifest.OriginalAsarSha256==manifest.OriginalAsarSha256),"INVALID_TRANSACTION_IDENTITY");
        var hash=File.Exists(asar)?Hash(asar):"";
        Check(hash==tx.BeforeSha256||hash==tx.AfterSha256,"RECOVERY_REFUSES_VENDOR_UPDATE");
        Check(Hash(Child(root,manifest.Executable))==manifest.ExecutableSha256,"RECOVERY_REFUSES_VENDOR_UPDATE");
        Check(Hash(Path.Combine(state,"original.asar"))==manifest.OriginalAsarSha256,"ORIGINAL_BACKUP_HASH_MISMATCH");
        if(tx.Committed){
            Check(hash==tx.AfterSha256,"COMMITTED_RESOURCE_DRIFT");
            var installed=Current();
            if(tx.Operation=="install"){
                Check(installed!=null&&installed.Manifest.PatchedAsarSha256==tx.AfterSha256,"COMMITTED_RECEIPT_MISMATCH");
                VerifyRecoveryManifest(installed!.Manifest);VerifyPayload(payload,installed.Manifest);
            }else Check(installed==null&&!Directory.Exists(payload),"COMMITTED_UNINSTALL_STATE_MISMATCH");
            assertIdle();Finish();log("recovered-committed");return;
        }
        // A newer installer can carry a different bootstrap. Only roll back an unfamiliar
        // target while its exact staged resource still proves which ASAR the journal names.
        // After an interrupted rollback, ASAR may already equal BeforeSha256 and stage may
        // have been cleaned; validating the rollback is sufficient to finish that recovery.
        if(tx.Operation=="install"&&tx.AfterSha256!=manifest.PatchedAsarSha256&&hash!=tx.BeforeSha256){
            var staged=Path.Combine(state,"stage","patched.asar");
            Check(File.Exists(staged)&&Hash(staged)==tx.AfterSha256,"RECOVERY_TARGET_RESOURCE_MISMATCH");
        }
        var rollback=Path.Combine(state,"rollback.asar");Check(Hash(rollback)==tx.BeforeSha256,"ROLLBACK_BACKUP_HASH_MISMATCH");
        var previous=Path.Combine(state,"previous-helper");
        if(prior!=null){VerifyRecoveryManifest(prior.Manifest);VerifyPayload(Directory.Exists(previous)?previous:payload,prior.Manifest);}
        else Check(!Directory.Exists(previous),"UNEXPECTED_PREVIOUS_PAYLOAD");
        assertIdle();
        File.Copy(rollback,Path.Combine(state,"replacement.asar"),true);File.Replace(Path.Combine(state,"replacement.asar"),asar,null);
        if(Directory.Exists(previous)){if(Directory.Exists(payload))Directory.Delete(payload,true);Directory.Move(previous,payload);}
        else if(!tx.HadPayload&&Directory.Exists(payload))Directory.Delete(payload,true);
        if(tx.BeforeReceipt!=null)WriteJson(Path.Combine(state,"receipt.json"),tx.BeforeReceipt);else File.Delete(Path.Combine(state,"receipt.json"));
        Finish();log("recovered-previous-installation");
    }
    void VerifyRecoveryManifest(Manifest value){
        Check(value.Kind==manifest.Kind&&value.Executable==manifest.Executable&&value.ExecutableVersion==manifest.ExecutableVersion&&
            value.ExecutableSha256==manifest.ExecutableSha256&&value.OriginalAsarSha256==manifest.OriginalAsarSha256&&
            value.PayloadFiles is {Count:>0}&&value.VendorFiles is {Count:>0},"INVALID_TRANSACTION_MANIFEST");
        foreach(var item in value.PayloadFiles){Child(payload,item.Key);Check(System.Text.RegularExpressions.Regex.IsMatch(item.Value??"","^[a-f0-9]{64}$"),"INVALID_TRANSACTION_MANIFEST");}
        foreach(var item in value.VendorFiles)Check(Hash(Child(root,item.Key))==item.Value,"RECOVERY_REFUSES_VENDOR_PAGE_DRIFT: "+item.Key);
    }
}

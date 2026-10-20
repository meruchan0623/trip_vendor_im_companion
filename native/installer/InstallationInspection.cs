using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace TripVendorInstaller;

public sealed record InspectionResult(string Root,string Source,bool SupportedForOperations,string Status,string ClientVersion,string? AssistantVersion,List<string> Evidence,List<string> Problems) {
    public string RuntimeNotice => "仅核对磁盘资源；不代表正在运行的客户端已加载助手。";
}
public sealed record InspectionReport(DateTimeOffset CheckedAt,List<InspectionResult> Installations,List<string> DiscoveryWarnings);

/// <summary>Read-only local evidence inspection. Receipts are local integrity references, not publisher signatures.</summary>
public static class InstallationInspection {
    public const string OfficialRoot = @"C:\Program Files\vbk-electron";
    const string Executable = "旅游商家桌面版.exe";
    static readonly Regex Sha = new("^[a-fA-F0-9]{64}$",RegexOptions.CultureInvariant);
    static void Require(bool value,string message){if(!value)throw new InvalidDataException(message);}
    // Check each ancestor before reading; never enumerate through a junction or symlink.
    static bool Exists(string path) {
        foreach(var ancestor in Ancestors(path)) {
            try {var attr=File.GetAttributes(ancestor);Require((attr&FileAttributes.ReparsePoint)==0,"拒绝读取重解析点："+ancestor);}
            catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}
        }
        return true;
    }
    static IEnumerable<string> Ancestors(string path){var full=Path.GetFullPath(path);var items=new Stack<string>();for(var p=full;p!=null;p=Path.GetDirectoryName(p))items.Push(p);return items;}
    static string Hash(string path){Require(Exists(path),"缺少文件："+path);return Engine.Hash(path);}
    static string Child(string root,string relative){Require(!string.IsNullOrWhiteSpace(relative)&&!Path.IsPathRooted(relative)&&!relative.Contains(':')&&!relative.Split('/','\\').Any(p=>p is "." or ".." or ""),"不安全的清单路径");return Engine.Child(root,relative);}
    static T Read<T>(string path){Require(Exists(path),"缺少状态文件："+path);using var stream=File.OpenRead(path);Require(stream.Length is >0 and <=4194304,"状态文件为空或过大："+path);return JsonSerializer.Deserialize<T>(stream,Engine.Json)??throw new InvalidDataException("状态文件内容为空");}
    static void Validate(Manifest m) {
        if(m==null)throw new InvalidDataException("收据清单缺失");
        Require(m.Kind=="trip-vendor-windows-injection-v1"&&!string.IsNullOrWhiteSpace(m.Version)&&!string.IsNullOrWhiteSpace(m.ExecutableVersion),"收据清单缺少身份信息");
        Require(Sha.IsMatch(m.ExecutableSha256??"")&&Sha.IsMatch(m.OriginalAsarSha256??"")&&Sha.IsMatch(m.PatchedAsarSha256??"")&&!string.Equals(m.OriginalAsarSha256,m.PatchedAsarSha256,StringComparison.OrdinalIgnoreCase),"收据资源哈希无效");
        Require(m.PayloadFiles is {Count:>0}&&m.VendorFiles is {Count:>0}&&m.PayloadFiles.Count<=20000&&m.VendorFiles.Count<=20000,"收据文件清单为空或过大");
        Child(OfficialRoot,m.Executable);
        foreach(var pair in m.PayloadFiles.Concat(m.VendorFiles)){Child(OfficialRoot,pair.Key);Require(Sha.IsMatch(pair.Value??""),"清单文件哈希无效："+pair.Key);}
    }
    static bool HasBootstrap(string asar) {
        using var file=File.OpenRead(asar);Span<byte> prefix=stackalloc byte[16];file.ReadExactly(prefix);
        var size=BinaryPrimitives.ReadUInt32LittleEndian(prefix[4..]);var payload=BinaryPrimitives.ReadUInt32LittleEndian(prefix[8..]);var length=BinaryPrimitives.ReadUInt32LittleEndian(prefix[12..]);
        Require(BinaryPrimitives.ReadUInt32LittleEndian(prefix)==4&&size>=8&&size<=64*1024*1024&&payload+4==size&&length<=payload-4&&8L+size<=file.Length,"无法识别 ASAR 头，不能确认未注入");
        var bytes=new byte[length];file.ReadExactly(bytes);using var json=JsonDocument.Parse(bytes);Require(json.RootElement.ValueKind==JsonValueKind.Object,"ASAR 根节点无效");Require(json.RootElement.TryGetProperty("files",out var files)&&files.ValueKind==JsonValueKind.Object,"ASAR 文件表无效");
        return files.TryGetProperty("trip-vendor-bootstrap.cjs",out _)||files.TryGetProperty("companion-vendor-original-main.json",out _);
    }
    static IEnumerable<string> PayloadFiles(string folder) {
        var pending=new Stack<string>();pending.Push(folder);var count=0;
        while(pending.Count>0)foreach(var entry in Directory.EnumerateFileSystemEntries(pending.Pop())) {
            Require(++count<=25000,"助手目录条目过多，停止检测");Require(Exists(entry),"文件在检测期间消失："+entry);
            if((File.GetAttributes(entry)&FileAttributes.Directory)!=0)pending.Push(entry);else yield return Path.GetRelativePath(folder,entry).Replace('\\','/');
        }
    }
    public static InspectionResult Inspect(string root,string source="指定路径",string executable=Executable) {
        root=Path.GetFullPath(root);var evidence=new List<string>();var problems=new List<string>();var status="无法读取";var version="未知";string? assistant=null;var supported=false;
        InspectionResult Result()=>new(root,source,supported,status,version,assistant,evidence,problems);
        try {
            // Discovery includes per-user registry values. Never turn a planted UNC,
            // device path or mapped share into an automatic network file access.
            if(!Regex.IsMatch(root,@"^[A-Za-z]:\\")||new DriveInfo(Path.GetPathRoot(root)!).DriveType!=DriveType.Fixed){problems.Add("只检测本机固定磁盘路径；未访问网络、设备或可移动磁盘路径");return Result();}
            if(!Exists(root)){status="未安装客户端";evidence.Add("候选安装目录不存在");return Result();}
            // Eligibility identifies a safe target, not compatibility or healthy injection.
            // Interrupted transactions must remain selectable for explicit recovery.
            try{InstallerTarget.Validate(root,executable);supported=true;}catch(Exception error)when(error is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or System.Security.SecurityException){supported=false;}
            var exe=Child(root,executable);var resources=Child(root,"resources");var asar=Child(resources,"app.asar");var state=Child(resources,"TripVendorCompanion.Install");var payload=Child(resources,"TripVendorCompanion");var receipt=Child(state,"receipt.json");
            if(Exists(exe))version=FileVersionInfo.GetVersionInfo(exe).FileVersion??"未知";
            var interrupted=Exists(Child(state,"pending.json"))||Exists(Child(resources,"TripVendorCompanion.migration.json"));
            if(interrupted){status="安装中断";problems.Add("存在安装事务或升级迁移日志；只读检测未执行恢复");return Result();}
            if(!Exists(receipt)) {
                if(Exists(payload)||Exists(Child(state,"receipt.json.new"))||Exists(Child(state,"stage"))||Exists(Child(state,"original.asar.new"))){status="损坏或部分注入";problems.Add("发现助手目录或未完成暂存文件，但没有有效安装收据");return Result();}
                if(!Exists(exe)||!Exists(asar)){status="损坏或部分注入";problems.Add("客户端目录存在，但主程序或 app.asar 缺失");return Result();}
                if(HasBootstrap(asar)){status="损坏或部分注入";problems.Add("ASAR 中存在助手入口，但缺少安装收据");return Result();}
                status="未注入";evidence.Add("客户端及 ASAR 文件表可读；未发现收据、助手目录或助手入口");return Result();
            }
            Receipt installed;
            try{installed=Read<Receipt>(receipt);Validate(installed.Manifest);}catch(Exception error)when(error is JsonException or InvalidDataException or ArgumentException){status="损坏或部分注入";problems.Add("安装收据无效："+error.Message);return Result();}
            var m=installed.Manifest;assistant=m.Version;evidence.Add("助手收据版本："+m.Version+"；安装时间："+installed.InstalledAt);
            if(!string.Equals(m.Executable,executable,StringComparison.OrdinalIgnoreCase)){status="损坏或部分注入";problems.Add("收据主程序名称与候选客户端不一致");return Result();}
            var original=Child(state,"original.asar");var currentHash=Exists(asar)?Hash(asar):null;var exeHash=Exists(exe)?Hash(exe):null;
            if(currentHash!=null)evidence.Add("当前 app.asar SHA256："+currentHash);
            bool backupOk=Exists(original)&&Hash(original)==m.OriginalAsarSha256.ToLowerInvariant();
            evidence.Add("原始备份："+(backupOk?"哈希匹配":"缺失或哈希不匹配"));if(!backupOk)problems.Add("原始备份缺失或损坏");
            if(!Exists(payload))problems.Add("助手目录缺失");
            else {
                var actual=PayloadFiles(payload).ToArray();if(!actual.Order(StringComparer.Ordinal).SequenceEqual(m.PayloadFiles.Keys.Order(StringComparer.Ordinal)))problems.Add("助手文件集合与清单不一致");
                foreach(var pair in m.PayloadFiles){var path=Child(payload,pair.Key);if(!Exists(path)||Hash(path)!=pair.Value.ToLowerInvariant())problems.Add("助手文件缺失或哈希不匹配："+pair.Key);}
                evidence.Add("已逐一核对助手清单文件："+m.PayloadFiles.Count);
            }
            foreach(var pair in m.VendorFiles){var path=Child(root,pair.Key);if(!Exists(path)||Hash(path)!=pair.Value.ToLowerInvariant())problems.Add("官方页面资源缺失或变化："+pair.Key);}
            if(exeHash==null||currentHash==null){status="损坏或部分注入";problems.Add("主程序或 app.asar 缺失");}
            else if(exeHash!=m.ExecutableSha256.ToLowerInvariant()||version!=m.ExecutableVersion){status="官方升级需重新注入";problems.Add("主程序版本或哈希已变化：可能官方升级，也可能资源漂移；需重新校验适配，不能据此确认官方来源");}
            else if(currentHash!=m.PatchedAsarSha256.ToLowerInvariant()) {status="损坏或部分注入";problems.Add(currentHash==m.OriginalAsarSha256.ToLowerInvariant()?"ASAR 已恢复原版，但收据仍存在":"ASAR 哈希与安装收据不符（可能升级或文件漂移）");}
            else if(problems.Count>0)status="损坏或部分注入";
            else {status="注入完整";evidence.Add("主程序、ASAR、原始备份、官方页面及全部助手文件哈希均匹配收据");}
            // Detect common concurrent replacement during inspection before claiming a complete result.
            if(status=="注入完整"&&(Hash(asar)!=currentHash||Hash(exe)!=exeHash||JsonSerializer.Serialize(Read<Receipt>(receipt),Engine.Json)!=JsonSerializer.Serialize(installed,Engine.Json))){status="无法读取";problems.Add("检测期间安装资源发生变化，请刷新");}
        }catch(Exception error)when(error is IOException or UnauthorizedAccessException or System.Security.SecurityException){status="无法读取";problems.Add(error.Message);}
        catch(Exception error)when(error is InvalidDataException or JsonException or ArgumentException or NotSupportedException){status="损坏或部分注入";problems.Add(error.Message);}
        return Result();
    }
    public static InspectionReport Discover() {
        var roots=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase){{OfficialRoot,"默认安装目录"}};var warnings=new List<string>();
        void Add(string? value,string source){if(string.IsNullOrWhiteSpace(value))return;try{value=Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));if(Path.IsPathFullyQualified(value)){var root=Path.GetFullPath(value).TrimEnd('\\');roots.TryAdd(root,source);}}catch(Exception error){warnings.Add(source+"："+error.Message);}}
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","vbk-electron"),"当前用户常用安装目录");
        Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"vbk-electron"),"当前用户兼容安装目录");
        foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser})foreach(var view in new[]{RegistryView.Registry64,RegistryView.Registry32})try {
            using var baseKey=RegistryKey.OpenBaseKey(hive,view);using var uninstall=baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");if(uninstall==null)continue;
            foreach(var name in uninstall.GetSubKeyNames())using(var key=uninstall.OpenSubKey(name)) {
                var display=key?.GetValue("DisplayName")as string;if(display?.Contains("旅游商家",StringComparison.Ordinal)!=true)continue;
                Add(key!.GetValue("InstallLocation")as string,"注册表安装记录");
                var icon=key.GetValue("DisplayIcon")as string;if(icon!=null){var match=Regex.Match(icon,"^\\s*(?:\"(?<path>[^\"]+\\.exe)\"|(?<path>.+?\\.exe))(?:,.*)?$",RegexOptions.IgnoreCase);if(match.Success&&Path.GetFileName(match.Groups["path"].Value).Equals(Executable,StringComparison.OrdinalIgnoreCase))Add(Path.GetDirectoryName(match.Groups["path"].Value),"注册表主程序路径");}
            }
        }catch(Exception error){warnings.Add("读取安装注册表失败："+error.Message);}
        foreach(var process in Process.GetProcesses())using(process)try{if(process.ProcessName!="旅游商家桌面版")continue;var image=process.MainModule?.FileName;if(image!=null)Add(Path.GetDirectoryName(image),"运行中客户端路径（不证明助手已加载）");}catch(Exception error){warnings.Add("读取客户端进程路径失败："+error.Message);}
        return new(DateTimeOffset.Now,roots.Select(p=>Inspect(p.Key,p.Value)).ToList(),warnings);
    }
}

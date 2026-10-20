using System.Reflection;
using System.Text;

namespace TripVendorInstaller;

public sealed record InjectionAdvice(string ButtonText,string Explanation,bool CanInstall);

/// <summary>Pure display/selection policy; never reads client files or changes inspection evidence.</summary>
public static class InspectionPresentation {
    static string? NormalizedRoot(string? root){if(string.IsNullOrWhiteSpace(root))return null;try{return Path.GetFullPath(root).TrimEnd('\\','/');}catch(Exception error)when(error is ArgumentException or NotSupportedException or IOException){return null;}}
    static bool SameRoot(string? left,string? right){var a=NormalizedRoot(left);var b=NormalizedRoot(right);return a!=null&&b!=null&&string.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
    public static string? PackageVersion(Assembly assembly)=>InstallerVersions.KnownVersion(assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);
    public static bool MissingSearchLocation(InspectionResult item)=>!item.SupportedForOperations&&item.Status=="未安装客户端"&&item.Problems.Count==0&&item.Source is "默认安装目录" or "当前用户常用安装目录" or "当前用户兼容安装目录";
    public static InspectionResult[] Choices(InspectionReport report)=>report.Installations.Where(p=>p.SupportedForOperations).ToArray();
    public static (string Root,string Source)[] SupplementalRoots(InspectionReport report,string? manualRoot,string? previousRoot) {
        var roots=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(var candidate in new[]{(Root:manualRoot,Source:"手动指定目录"),(Root:previousRoot,Source:"先前所选操作目标")}){
            var normalized=NormalizedRoot(candidate.Root);if(normalized==null)continue;
            if(!report.Installations.Any(p=>SameRoot(p.Root,normalized)))roots.TryAdd(normalized,candidate.Source);
        }
        return roots.Select(p=>(p.Key,p.Value)).ToArray();
    }
    public static InspectionReport WithSelectionContext(InspectionReport report,string? manualRoot,string? previousRoot)=>report with{
        Installations=report.Installations.Select(item=>
            SameRoot(item.Root,manualRoot)?item with{Source="手动指定目录"}:
            SameRoot(item.Root,previousRoot)&&MissingSearchLocation(item)?item with{Source="先前所选操作目标（"+item.Source+"）"}:item).ToList()
    };
    public static InspectionResult? Select(InspectionReport report,string? previousRoot,bool explicitSelection) {
        var choices=Choices(report);
        // A lost selection must never silently switch operations to another client.
        if(previousRoot!=null||explicitSelection)return choices.FirstOrDefault(p=>SameRoot(p.Root,previousRoot));
        return choices.Length==1?choices[0]:null;
    }
    public static InjectionAdvice Advice(InspectionResult item,string? packageVersion) {
        if(item.Status=="安装中断")return new("请先恢复中断安装","发现未完成安装事务；请先点击「恢复中断安装」，恢复后重新检测。",false);
        if(InstallerVersions.KnownVersion(packageVersion)==null)return new("安装包版本无法确认","本安装包缺少可确认的版本；请使用正式构建的安装包。",false);
        if(item.AssistantVersion==null&&item.Status=="未注入")return new("注入助手 "+packageVersion,"尚未注入；可安装本包助手 "+packageVersion+"。",true);
        if(!InstallerVersions.TryCompare(item.AssistantVersion,packageVersion,out var comparison))return new("重新校验 / 注入 "+packageVersion,"已安装助手版本无法确认；不判断是否最新。操作将重新校验兼容性并尝试注入本包版本。",true);
        if(comparison>0)return new("请使用更新安装包","已装助手 "+item.AssistantVersion+" 高于本安装包 "+packageVersion+"；为避免降级，请使用同版或更新安装包。",false);
        if(comparison<0)return new(item.AssistantVersion+" → "+packageVersion+" 更新注入","可更新助手："+item.AssistantVersion+" → "+packageVersion+"；仍须通过安装前完整校验。",true);
        return new("重新注入 "+packageVersion,"助手已是本安装包版本；需要修复或重新适配时可重新注入。",true);
    }
    static void AppendItem(StringBuilder text,InspectionResult item,bool details) {
        text.AppendLine("客户端路径："+item.Root+"（"+item.Source+"）")
            .AppendLine("磁盘状态："+item.Status+"；客户端版本："+item.ClientVersion+"；已装助手："+(item.AssistantVersion??"未知 / 未安装"));
        if(!item.SupportedForOperations&&!MissingSearchLocation(item))text.AppendLine("不能选为操作目标：路径、主程序身份或客户端目录结构未通过校验。");
        if(item.Status=="未安装客户端")text.AppendLine("该候选目录不存在；请核对路径或重新选择客户端安装目录。");
        foreach(var issue in item.Problems)text.AppendLine("异常："+issue);
        if(details){foreach(var proof in item.Evidence)text.AppendLine("证据："+proof);text.AppendLine(item.RuntimeNotice);}
    }
    public static string Render(InspectionReport report,InspectionResult? selected,string? packageVersion,bool details) {
        var choices=Choices(report);var missing=report.Installations.Count(MissingSearchLocation);
        var text=new StringBuilder("检测时间："+report.CheckedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")+Environment.NewLine);
        text.AppendLine("本安装包助手版本："+(packageVersion??"无法确认"));
        text.AppendLine(choices.Length>0?"已找到 "+choices.Length+" 个可选择的客户端（安装前仍须校验）。":"未找到可选择的客户端；请手动选择安装目录或查看下方异常。");
        if(selected!=null){text.AppendLine().AppendLine("本次操作目标："+selected.Root);AppendItem(text,selected,false);text.AppendLine(Advice(selected,packageVersion).Explanation);}
        else text.AppendLine("尚未选定操作目标；请从目录列表明确选择，或手动选择安装目录。");
        text.AppendLine("「注入完整」仅表示磁盘资源匹配收据，不表示助手为最新版本，也不证明运行中的客户端已加载助手。");
        foreach(var item in report.Installations.Where(p=>!MissingSearchLocation(p)&&!ReferenceEquals(p,selected))) {
            text.AppendLine().AppendLine("其他检测结果：");AppendItem(text,item,false);
        }
        foreach(var warning in report.DiscoveryWarnings)text.AppendLine("发现范围提示："+warning);
        if(missing>0)text.AppendLine().AppendLine("另有 "+missing+" 个搜索位置不存在；"+(choices.Length>0?"这不影响已找到的客户端。":"可手动选择实际客户端目录。")+"勾选「完整检测详情」可查看全部候选和证据。");
        if(details){text.AppendLine().AppendLine("—— 完整检测详情（含未安装的搜索位置）——");foreach(var item in report.Installations){text.AppendLine();AppendItem(text,item,true);}}
        return text.ToString();
    }
}

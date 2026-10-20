using System.Diagnostics;
using System.Text.RegularExpressions;

namespace TripVendorInstaller;

/// <summary>Resolve a single local installation before elevation, probing or process termination.</summary>
static class InstallerTarget {
    internal const string Executable = "旅游商家桌面版.exe";
    internal static string Normalize(string value) {
        // Reject device/UNC, drive-relative paths and ADS before any filesystem access.
        if(string.IsNullOrWhiteSpace(value)||!Regex.IsMatch(value,@"^[A-Za-z]:[\\/]")||value[2..].Contains(':')||value.StartsWith(@"\\"))throw new InvalidOperationException("TARGET_LOCAL_FIXED_PATH_REQUIRED: 请选择本机固定磁盘上的客户端目录。");
        var normalized=value.Replace('/','\\').TrimEnd('\\');
        if(normalized.Length<=3||normalized.Length>240||normalized.Any(char.IsControl)||normalized[3..].Split('\\').Any(part=>part.Length==0||part is "." or ".."||part.EndsWith(' ')||part.EndsWith('.')||part.IndexOfAny(['<','>','"','|','?','*'])>=0||Regex.IsMatch(part,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant)))throw new InvalidOperationException("TARGET_NONCANONICAL_PATH: 路径超过 240 字符，或包含空段、相对目录、尾点空格、保留名称、控制符或非法字符。");
        var root=Path.GetFullPath(normalized);
        if(root.Length<=3||new DriveInfo(Path.GetPathRoot(root)!).DriveType!=DriveType.Fixed)throw new InvalidOperationException("TARGET_LOCAL_FIXED_PATH_REQUIRED: 不支持磁盘根目录、网络、设备或可移动磁盘。");
        return root;
    }
    internal static string Validate(string value,string executable=Executable) {
        var root=Normalize(value);
        if(!Directory.Exists(root))throw new InvalidOperationException("TARGET_NOT_FOUND: 客户端目录不存在："+root);
        var exe=Engine.Child(root,executable);var asar=Engine.Child(root,"resources/app.asar");
        // Check the ancestors without recursively scanning a mistakenly selected large
        // parent directory; enumerate the tree only after identifying the client layout.
        Engine.NoLinks(exe);Engine.NoLinks(asar);
        if(!File.Exists(exe)||!File.Exists(asar))throw new InvalidOperationException("TARGET_CLIENT_STRUCTURE_REQUIRED: 请选择同时包含旅游商家桌面版.exe 和 resources/app.asar 的客户端目录。");
        if(FileVersionInfo.GetVersionInfo(exe).ProductName!="旅游商家桌面版")throw new InvalidOperationException("TARGET_PRODUCT_IDENTITY_MISMATCH: 主程序不是旅游商家桌面版。");
        Engine.NoLinks(root);
        return root;
    }
    internal static string Resolve(string? requested,InspectionReport report) {
        if(requested!=null)return Validate(requested);
        var roots=report.Installations.Where(p=>p.SupportedForOperations).Select(p=>p.Root).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if(roots.Length!=1)throw new InvalidOperationException(roots.Length==0?"TARGET_REQUIRED: 未找到有效客户端，请选择目录或使用 --root。":"TARGET_AMBIGUOUS: 发现多个客户端，请明确选择目录或使用 --root。");
        return Validate(roots[0]);
    }
    internal static void ValidateForceExitIdentity(bool forceExit,string initiatingUser,string currentUser) {
        if(forceExit&&!string.Equals(initiatingUser,currentUser,StringComparison.Ordinal))throw new InvalidOperationException("FORCE_EXIT_CROSS_USER_ELEVATION_REFUSED: 提权使用了其他 Windows 用户，请手动退出原用户的客户端、助手和更新程序后重试。");
    }
    internal static string[] ElevationArguments(string operation,string root,string logPath,bool forceExit,string initiatingUser) {
        var args=new List<string>{"--action",operation,"--root",root,"--log",logPath,"--initiating-user",initiatingUser};
        if(forceExit)args.Add("--force-exit-client");return args.ToArray();
    }
}

sealed record InstallerOptions(string Action,string? Root,string? Log,bool ForceExit,bool Inspect,string? InitiatingUser) {
    internal static InstallerOptions Parse(string[] args) {
        string action="";string? root=null,log=null,user=null;bool force=false,inspect=false;var seen=new HashSet<string>();
        for(var i=0;i<args.Length;i++) {
            var option=args[i];if(!seen.Add(option))throw new ArgumentException("DUPLICATE_OPTION: "+option);
            string Value(){if(i+1>=args.Length||args[i+1].StartsWith("--",StringComparison.Ordinal))throw new ArgumentException("MISSING_OPTION_VALUE: "+option);return args[++i];}
            switch(option){case "--action":action=Value();break;case "--root":root=Value();break;case "--log":log=Path.GetFullPath(Value());break;case "--initiating-user":user=Value();break;case "--force-exit-client":force=true;break;case "--inspect":inspect=true;break;default:throw new ArgumentException("用法：安装器.exe [--action install|uninstall|recover|check] [--root 客户端目录] [--log 日志文件]；只读检测：--inspect [--root 目录]");}
        }
        if(action!=""&&action is not ("install" or "uninstall" or "recover" or "check"))throw new ArgumentException("INVALID_OPERATION");
        if(inspect&&(action!=""||force||log!=null||user!=null))throw new ArgumentException("INSPECT_OPTIONS_INVALID");
        if(force&&(action==""||action=="check"))throw new ArgumentException(action=="check"?"FORCE_EXIT_NOT_ALLOWED_FOR_CHECK":"FORCE_EXIT_REQUIRES_ACTION");
        if(user!=null&&action=="")throw new ArgumentException("INITIATING_USER_REQUIRES_ACTION");
        return new(action,root,log,force,inspect,user);
    }
}

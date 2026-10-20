using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace TripVendorInstaller;

static class TargetPrivileges {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
    static bool CanWriteDirectory(string path) {
        // Request directory write rights without creating files or modifying timestamps.
        using var handle=CreateFileW(path,0x00000002|0x00000004,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
        if(!handle.IsInvalid)return true;
        var error=Marshal.GetLastWin32Error();if(error==5)return false;throw new Win32Exception(error,"TARGET_ACCESS_CHECK_FAILED: "+path);
    }
    internal static bool NeedsElevation(string root)=>!CanWriteDirectory(Path.Combine(root,"resources"));
    static bool Trusted(SecurityIdentifier sid)=>sid.Value is "S-1-5-18" or "S-1-5-32-544" or "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    internal static void AssertProtectedAcl(FileSystemSecurity acl,bool ancestor=false) {
        if(acl.GetOwner(typeof(SecurityIdentifier))is not SecurityIdentifier owner||!Trusted(owner))throw new InvalidOperationException("ELEVATED_TARGET_UNPROTECTED: 客户端目录由普通用户控制，请关闭安装器后以普通方式启动。");
        var writes=FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles;
        if(!ancestor)writes|=FileSystemRights.Write;
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
            // Inherit-only entries do not affect this object; descendants are checked individually.
            if((rule.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;
            if(rule.AccessControlType==AccessControlType.Allow&&(rule.FileSystemRights&writes)!=0&&!Trusted((SecurityIdentifier)rule.IdentityReference))throw new InvalidOperationException("ELEVATED_TARGET_UNPROTECTED: 客户端资源可被普通用户修改，请以普通方式启动安装器。");
        }
    }
    internal static void AssertSafeForElevatedProbe(string root) {
        Engine.NoLinks(root);
        for(var parent=Directory.GetParent(root);parent!=null;parent=parent.Parent)AssertProtectedAcl(parent.GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access),true);
        AssertProtectedAcl(new DirectoryInfo(root).GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access));
        foreach(var path in Directory.EnumerateFileSystemEntries(root,"*",SearchOption.AllDirectories)) {
            FileSystemSecurity acl=Directory.Exists(path)?new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access):new FileInfo(path).GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access);
            AssertProtectedAcl(acl);
        }
    }
}

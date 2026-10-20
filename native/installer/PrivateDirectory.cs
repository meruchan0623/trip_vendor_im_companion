using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

namespace TripVendorInstaller;

/// <summary>Private staging, secured at creation rather than sealed after extraction starts.</summary>
static class PrivateDirectory {
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {internal int Length;internal IntPtr Descriptor;internal int InheritHandle;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    static extern bool CreateDirectoryW(string path,ref SecurityAttributes attributes);
    static bool Trusted(SecurityIdentifier sid,string user)=>sid.Value==user||sid.Value is "S-1-5-18" or "S-1-5-32-544" or "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    static bool AppContainer(SecurityIdentifier sid)=>Regex.IsMatch(sid.Value,@"^S-1-15-(2|3)-[0-9]+(-[0-9]+)*$");
    static void Require(bool value,string code){if(!value)throw new InvalidOperationException(code);}
    internal static void AssertParentAcl(DirectorySecurity acl,string user){
        Require(acl.GetOwner(typeof(SecurityIdentifier))is SecurityIdentifier owner&&Trusted(owner,user),"PRIVATE_TEMP_UNSAFE_ANCESTOR_OWNER");
        // Creating siblings or granting inheritable write does not replace a private
        // child. Deleting children, changing ACLs/owner or deleting an ancestor does.
        const long replacementMask=0x100D0040;
        foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))){
            if(rule.AccessControlType!=AccessControlType.Allow||(rule.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;
            var sid=(SecurityIdentifier)rule.IdentityReference;
            // AppContainer access intersects user/group access; these are neither
            // independent ordinary user grants nor trusted owners.
            Require(((long)rule.FileSystemRights&replacementMask)==0||Trusted(sid,user)||AppContainer(sid),"PRIVATE_TEMP_UNSAFE_ANCESTOR_ACCESS");
        }
    }
    static void AssertAncestors(string parent,string user){
        for(var directory=new DirectoryInfo(parent);directory!=null;directory=directory.Parent){
            Require(directory.Exists&&(directory.Attributes&FileAttributes.ReparsePoint)==0,"PRIVATE_TEMP_REPARSE_OR_MISSING_ANCESTOR");
            AssertParentAcl(directory.GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access),user);
        }
    }
    internal static string CreateStaging(){
        // Some Temp directories deliberately permit other local/sandbox users to
        // delete children. A protected child cannot make such a parent safe.
        // Use a fresh random directory under this user's LocalAppData instead;
        // the same complete ancestry checks still apply before creation.
        var parent=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        Require(!string.IsNullOrWhiteSpace(parent),"PRIVATE_TEMP_PARENT_REQUIRED");
        return CreateNew(Path.Combine(parent,"TripVendorCompanion-Setup-"+Guid.NewGuid().ToString("N")));
    }
    internal static string CreateNew(string path){
        path=InstallerTarget.Normalize(path);var parent=Path.GetDirectoryName(path)??throw new InvalidOperationException("PRIVATE_TEMP_PARENT_REQUIRED");
        var user=WindowsIdentity.GetCurrent().User??throw new InvalidOperationException("WINDOWS_USER_IDENTITY_UNAVAILABLE");
        AssertAncestors(parent,user.Value);
        var security=new DirectorySecurity();security.SetOwner(user);security.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{user,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")}.Distinct())security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        var bytes=security.GetSecurityDescriptorBinaryForm();var descriptor=Marshal.AllocHGlobal(bytes.Length);
        try{
            Marshal.Copy(bytes,0,descriptor,bytes.Length);var attributes=new SecurityAttributes{Length=Marshal.SizeOf<SecurityAttributes>(),Descriptor=descriptor};
            // Win32 fails for a pre-existing path. Never adopt, seal or delete it.
            if(!CreateDirectoryW(path,ref attributes)){var error=Marshal.GetLastWin32Error();if(error==183)throw new InvalidOperationException("PRIVATE_TEMP_ALREADY_EXISTS");throw new Win32Exception(error,"PRIVATE_TEMP_CREATE_FAILED");}
        }finally{Marshal.FreeHGlobal(descriptor);}
        AssertAncestors(parent,user.Value);
        var created=new DirectoryInfo(path);Require((created.Attributes&FileAttributes.ReparsePoint)==0,"PRIVATE_TEMP_REDIRECTED");
        var actual=created.GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access);
        Require(actual.AreAccessRulesProtected&&actual.GetOwner(typeof(SecurityIdentifier))is SecurityIdentifier owner&&owner.Value==user.Value,"PRIVATE_TEMP_SECURITY_MISMATCH");
        foreach(FileSystemAccessRule rule in actual.GetAccessRules(true,true,typeof(SecurityIdentifier)))Require(rule.AccessControlType!=AccessControlType.Allow||Trusted((SecurityIdentifier)rule.IdentityReference,user.Value),"PRIVATE_TEMP_SECURITY_MISMATCH");
        return path;
    }
}

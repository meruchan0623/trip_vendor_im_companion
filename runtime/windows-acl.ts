/**
 * AppContainer package/capability grants are a second access-check principal,
 * intersected with the traditional user/group grant; they cannot independently
 * give another user access. They are not trusted owners or ordinary groups.
 * https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
 * Unknown account SIDs (including S-1-5-21 sandbox-looking SIDs) remain untrusted.
 */
export function windowsManifestAclScript(paths:readonly string[],ancestors:readonly string[]):string{
  const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
  return `$privileged=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
$trusted=$privileged+@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value);
$ancestors=@(${ancestors.map(literal).join(',')});$protected=$true;
foreach($path in @(${[...ancestors,...paths].map(literal).join(',')})){
  $writeMask=if($path -in $ancestors){[long]0x100D0040}else{[long]0x500D0156};
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop;
  # Null/absent DACL grants everyone full access; an allocated empty DACL does not.
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);
  if(-not ($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $descriptor.DiscretionaryAcl){$protected=$false};
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
  if($owner -notin $trusted){$protected=$false};
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    $appContainerPrincipal=$rule.IdentityReference.Value -match '^S-1-15-(2|3)-[0-9]+(-[0-9]+)*$';
    if($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and (([long]$rule.FileSystemRights -band $writeMask) -ne 0) -and $rule.IdentityReference.Value -notin $trusted -and -not $appContainerPrincipal){$protected=$false}
  }
};@{protected=$protected}|ConvertTo-Json -Compress`;
}

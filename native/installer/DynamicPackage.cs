using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace TripVendorInstaller;

/// <summary>Capability-gated local adaptation. Hashes bind this installation; they are not publisher signatures.</summary>
static class DynamicPackage {
    const string BootstrapName="trip-vendor-bootstrap.cjs", OriginalMainName="companion-vendor-original-main.json";
    static void Check(bool value,string code){if(!value)throw new InvalidOperationException(code);}
    static string Hash(byte[] value)=>Convert.ToHexStringLower(SHA256.HashData(value));
    static string Text(ZipArchive zip,string name)=>Read(zip,name).Length<=1024*1024?Encoding.UTF8.GetString(Read(zip,name)):throw new InvalidDataException("PACKAGE_TEXT_TOO_LARGE");
    static byte[] Read(ZipArchive zip,string name){using var input=(zip.GetEntry(name)??throw new InvalidDataException("PACKAGE_FILE_MISSING "+name)).Open();using var buffer=new MemoryStream();input.CopyTo(buffer);return buffer.ToArray();}
    static (JsonObject Header,long DataStart) Header(string path){
        using var file=File.OpenRead(path);var prefix=new byte[16];file.ReadExactly(prefix);
        var size=BinaryPrimitives.ReadUInt32LittleEndian(prefix.AsSpan(4));var payload=BinaryPrimitives.ReadUInt32LittleEndian(prefix.AsSpan(8));var length=BinaryPrimitives.ReadUInt32LittleEndian(prefix.AsSpan(12));
        Check(BinaryPrimitives.ReadUInt32LittleEndian(prefix)==4&&size>=8&&size<=64*1024*1024&&payload+4==size&&length<=payload-4&&8L+size<=file.Length,"UNSUPPORTED_ASAR_HEADER");
        var bytes=new byte[length];file.ReadExactly(bytes);var root=JsonNode.Parse(bytes)as JsonObject??throw new InvalidDataException("INVALID_ASAR_JSON");Check(root["files"]is JsonObject,"INVALID_ASAR_FILES");return(root,8L+size);
    }
    static byte[] PackedFile(string path,JsonObject header,long start,string relative,int limit){
        Engine.Child(Path.GetDirectoryName(path)!,relative);JsonNode? entry=header;
        foreach(var part in relative.Replace('\\','/').Split('/'))entry=entry?["files"]?[part];
        Check(entry!=null&&entry["unpacked"]?.GetValue<bool>()!=true&&entry["link"]==null,"UNSUPPORTED_PACKED_FILE "+relative);
        Check(long.TryParse(entry!["offset"]?.GetValue<string>(),out var offset)&&offset>=0,"INVALID_ASAR_OFFSET");var size=entry["size"]?.GetValue<int>()??-1;
        using var file=File.OpenRead(path);Check(size>=0&&size<=limit&&start+offset+size<=file.Length,"INVALID_ASAR_FILE_SIZE");file.Position=start+offset;var bytes=new byte[size];file.ReadExactly(bytes);return bytes;
    }
    static JsonObject Entry(byte[] bytes,long offset){
        var blocks=new JsonArray();for(var index=0;index<bytes.Length;index+=4194304)blocks.Add(Hash(bytes[index..Math.Min(index+4194304,bytes.Length)]));
        return new JsonObject{["size"]=bytes.Length,["offset"]=offset.ToString(),["integrity"]=new JsonObject{["algorithm"]="SHA256",["hash"]=Hash(bytes),["blockSize"]=4194304,["blocks"]=blocks}};
    }
    static (string Main,string OriginalSha256) PatchAsar(string original,string destination,byte[] bootstrap,string packageVersion){
        using var stableOriginal=new FileStream(original,FileMode.Open,FileAccess.Read,FileShare.Read);
        var (header,start)=Header(original);var pkg=JsonNode.Parse(PackedFile(original,header,start,"package.json",1024*1024))as JsonObject??throw new InvalidDataException("INVALID_VENDOR_PACKAGE");
        var main=pkg["main"]?.GetValue<string>()??"";Check(main.Length>0&&!Path.IsPathRooted(main)&&!main.Contains(':')&&!main.Split('/','\\').Contains("..")&&pkg["type"]?.GetValue<string>()!="module","UNSUPPORTED_VENDOR_MAIN");
        Check(pkg["version"]?.GetValue<string>()==packageVersion,"ASAR_PACKAGE_VERSION_MISMATCH");
        var files=(JsonObject)header["files"]!;Check(files[BootstrapName]==null&&files[OriginalMainName]==null,"ALREADY_PATCHED_WITHOUT_RECEIPT");
        var source=Encoding.UTF8.GetString(PackedFile(original,header,start,main,32*1024*1024));
        foreach(var token in new[]{"requestSingleInstanceLock","whenReady","USER_DIST","UNPACKED_DIST","isUserPath"})Check(source.Contains(token,StringComparison.Ordinal),"UNSUPPORTED_VENDOR_ENTRY_CONTRACT "+token);
        pkg["main"]=BootstrapName;var additions=new[]{JsonSerializer.SerializeToUtf8Bytes(pkg,Engine.Json),bootstrap,JsonSerializer.SerializeToUtf8Bytes(new{main})};
        using var input=File.OpenRead(original);long offset=input.Length-start;
        for(var i=0;i<additions.Length;i++){files[new[]{"package.json",BootstrapName,OriginalMainName}[i]]=Entry(additions[i],offset);offset+=additions[i].Length;}
        var json=JsonSerializer.SerializeToUtf8Bytes(header);var padded=(json.Length+3)/4*4;var prefix=new byte[16+padded];
        BinaryPrimitives.WriteUInt32LittleEndian(prefix,4);BinaryPrimitives.WriteUInt32LittleEndian(prefix.AsSpan(4),(uint)(8+padded));BinaryPrimitives.WriteUInt32LittleEndian(prefix.AsSpan(8),(uint)(4+padded));BinaryPrimitives.WriteUInt32LittleEndian(prefix.AsSpan(12),(uint)json.Length);json.CopyTo(prefix,16);
        using var output=new FileStream(destination,FileMode.Create,FileAccess.Write,FileShare.None);output.Write(prefix);input.Position=start;input.CopyTo(output);foreach(var bytes in additions)output.Write(bytes);output.Flush(true);return(main,Engine.Hash(original));
    }
    static int RuntimeCapabilities(string executable,Action<string> log){
        var binary=File.ReadAllBytes(executable);var sentinel=Encoding.ASCII.GetBytes("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");var index=binary.AsSpan().IndexOf(sentinel);
        Check(index>=0&&index+sentinel.Length+9<binary.Length,"UNSUPPORTED_ELECTRON_FUSES");var start=index+sentinel.Length;
        Check(binary[start]==1&&binary[start+1]>=7&&binary[start+2]==49&&binary[start+2+4]==48,"UNSUPPORTED_ELECTRON_INTEGRITY_OR_NODE_CAPABILITY");
        var info=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
        info.Environment["ELECTRON_RUN_AS_NODE"]="1";info.Environment.Remove("NODE_OPTIONS");info.Environment.Remove("ELECTRON_NO_ASAR");
        info.ArgumentList.Add("-p");info.ArgumentList.Add("JSON.stringify({electron:process.versions.electron,chrome:process.versions.chrome,arch:process.arch})");
        using var process=Process.Start(info)??throw new InvalidOperationException("RUNTIME_PROBE_START_FAILED");
        var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();
        if(!process.WaitForExit(15000)){process.Kill();throw new InvalidOperationException("RUNTIME_PROBE_TIMEOUT");}
        Check(process.ExitCode==0,"RUNTIME_PROBE_FAILED");var result=JsonNode.Parse(stdout.GetAwaiter().GetResult())??throw new InvalidDataException("RUNTIME_PROBE_INVALID");
        Version.TryParse(result["electron"]?.GetValue<string>(),out var electron);Version.TryParse(result["chrome"]?.GetValue<string>(),out var chrome);
        Check(electron!=null&&electron.Major>=27&&chrome!=null&&chrome.Major>=118&&result["arch"]?.GetValue<string>()=="x64","UNSUPPORTED_ELECTRON_VERSION");
        log("Electron能力探测通过: "+result.ToJsonString());
        return chrome!.Major;
    }
    static JsonObject ProbePages(string root,out Dictionary<string,string> vendorFiles){
        var dist=Path.Combine(root,"resources","app.asar.unpacked","dist");
        static byte[] ReadBounded(string path,int limit){using var input=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);Check(input.Length<=limit,"PAGE_RESOURCE_TOO_LARGE");var bytes=new byte[input.Length];input.ReadExactly(bytes);return bytes;}
        var versionPath=Path.Combine(dist,"packageVersion.json");var versionBytes=ReadBounded(versionPath,16000);var version=JsonNode.Parse(versionBytes)??throw new InvalidDataException("INVALID_PAGE_VERSION");
        foreach(var field in new[]{"pkgVersion","aresVersion"})Check(version[field] is JsonValue value&&value.TryGetValue<string>(out var text)&&text!=null&&Regex.IsMatch(text,@"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,9}$"),"UNSUPPORTED_WINDOWS_PAGE_VERSION "+field);
        var names=new[]{"imPlus","main"};var scripts=new List<string>();var paths=new List<string>();var snapshots=new List<byte[]>();
        for(var i=0;i<2;i++){
            var html=Path.Combine(dist,"src","pages",names[i],"index.html");var htmlBytes=ReadBounded(html,20000);var text=new UTF8Encoding(false,true).GetString(htmlBytes);
            Check(Regex.Matches(text,@"\bid\s*=\s*[""']root[""']").Count==1,"UNSUPPORTED_PAGE_ROOT");
            var matches=Regex.Matches(text,@"<script\b[^>]*>",RegexOptions.IgnoreCase);
            var modules=matches.Where(m=>Regex.IsMatch(m.Value,@"\btype\s*=\s*[""']module[""']",RegexOptions.IgnoreCase)).ToArray();Check(modules.Length==1,"UNSUPPORTED_PAGE_MODULE_COUNT");
            Check(Regex.Matches(modules[0].Value,@"\bsrc\s*=",RegexOptions.IgnoreCase).Count==1,"UNSUPPORTED_PAGE_SCRIPT_ATTRIBUTE");
            var candidates=modules.Select(m=>Regex.Match(m.Value,@"\bsrc\s*=\s*[""'](?<src>[^""']+)[""']",RegexOptions.IgnoreCase).Groups["src"].Value).Where(p=>Regex.IsMatch(p,@"(?:^|/)"+(i==0?"imWindow":"mainWindow")+@"-[A-Za-z0-9_-]{1,80}\.js$",RegexOptions.CultureInvariant)).ToArray();
            Check(candidates.Length==1,"UNSUPPORTED_PAGE_ENTRY "+names[i]);
            Check(Regex.IsMatch(candidates[0],@"^\.\./\.\./\.\./js/[A-Za-z0-9_-]+\.js$"),"UNSUPPORTED_PAGE_SCRIPT_REFERENCE");
            var script=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(html)!,candidates[0].Replace('/',Path.DirectorySeparatorChar)));
            Check(script.StartsWith(dist+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase),"PAGE_SCRIPT_PATH_ESCAPE");
            scripts.Add(Path.GetFileName(script));paths.Add(html);paths.Add(script);snapshots.Add(htmlBytes);snapshots.Add(ReadBounded(script,i==0?8000000:200000));
        }
        var im=new UTF8Encoding(false,true).GetString(snapshots[1]);foreach(var token in new[]{"chat-editor","chat_area-input","chat_area-button","btn_send","setContent","chat_area-list","chat_list_content","normal-message-item","customer_order-detail","group-chat-hover-box","chat-text","preserveWhitespace"})Check(im.Contains(token,StringComparison.Ordinal),"UNSUPPORTED_EDITOR_CONTRACT "+token);
        var nav=new UTF8Encoding(false,true).GetString(snapshots[3]);foreach(var token in new[]{"menu-item-wrapper","menu-text"})Check(nav.Contains(token,StringComparison.Ordinal),"UNSUPPORTED_NAVIGATION_CONTRACT "+token);
        var hashes=snapshots.Select(Hash).ToArray();vendorFiles=new();for(var i=0;i<paths.Count;i++)vendorFiles[Path.GetRelativePath(root,paths[i]).Replace('\\','/')]=hashes[i];vendorFiles[Path.GetRelativePath(root,versionPath).Replace('\\','/')]=Hash(versionBytes);
        return new JsonObject{["packageVersion"]=version["pkgVersion"]?.GetValue<string>(),["aresVersion"]=version["aresVersion"]?.GetValue<string>(),["rendererName"]=scripts[0],["navigationRendererName"]=scripts[1],["htmlSha256"]=hashes[0],["rendererSha256"]=hashes[1],["navigationHtmlSha256"]=hashes[2],["navigationRendererSha256"]=hashes[3]};
    }
    public static (Manifest Manifest,string Zip) Prepare(string root,string packageZip,string temp,Action<string> log,string operation="install",Func<string,int>? capabilityProbe=null){
        Engine.NoLinks(root);using var zip=ZipFile.OpenRead(packageZip);var package=JsonSerializer.Deserialize<Manifest>(Text(zip,"manifest.json"),Engine.Json)??throw new InvalidDataException("INVALID_PACKAGE_MANIFEST");
        if(!package.Dynamic)return(package,packageZip);
        var executable=Path.Combine(root,package.Executable);var product=FileVersionInfo.GetVersionInfo(executable);var fileVersion=product.FileVersion??"";
        var initialExecutableSha256=Engine.Hash(executable);
        Check(product.ProductName=="旅游商家桌面版","UNSUPPORTED_VENDOR_PRODUCT_IDENTITY");
        Check(Regex.IsMatch(fileVersion,@"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,9}(?:\.[0-9]{1,10})?$"),"UNSUPPORTED_EXECUTABLE_VERSION");
        Check(Version.TryParse(fileVersion,out var parsed)&&parsed>=new Version(1,2,11),"CLIENT_VERSION_BELOW_1_2_11");
        var currentAsar=Path.Combine(root,"resources","app.asar");var original=currentAsar;var state=Path.Combine(root,"resources","TripVendorCompanion.Install");
        bool rebase=false;
        var migrationPath=Path.Combine(root,"resources","TripVendorCompanion.migration.json");
        if(File.Exists(migrationPath)){
            var migration=JsonSerializer.Deserialize<Migration>(File.ReadAllText(migrationPath),Engine.Json)??throw new InvalidDataException("INVALID_MIGRATION");
            Check(Engine.Hash(currentAsar)==migration.NewOriginalSha256&&initialExecutableSha256==migration.NewExecutableSha256,"MIGRATION_REFUSES_VENDOR_DRIFT");
        }
        else if(File.Exists(Path.Combine(state,"pending.json"))){
            var transaction=JsonSerializer.Deserialize<Transaction>(File.ReadAllText(Path.Combine(state,"pending.json")),Engine.Json)??throw new InvalidDataException("INVALID_TRANSACTION");
            var currentHash=Engine.Hash(currentAsar);Check(currentHash==transaction.BeforeSha256||currentHash==transaction.AfterSha256,"OFFICIAL_UPDATE_OR_RESOURCE_DRIFT");
            original=Path.Combine(state,"original.asar");Check(Engine.Hash(original)==(transaction.BeforeReceipt?.Manifest.OriginalAsarSha256??transaction.BeforeSha256),"ORIGINAL_BACKUP_HASH_MISMATCH");
        }
        else if(File.Exists(Path.Combine(state,"receipt.json"))){
            var receipt=JsonSerializer.Deserialize<Receipt>(File.ReadAllText(Path.Combine(state,"receipt.json")),Engine.Json)??throw new InvalidDataException("INVALID_INSTALL_RECEIPT");
            if(Engine.Hash(executable)!=receipt.Manifest.ExecutableSha256||Engine.Hash(currentAsar)!=receipt.Manifest.PatchedAsarSha256){Check(operation=="install","OFFICIAL_UPDATE_OR_RESOURCE_DRIFT");rebase=true;}
            else{original=Path.Combine(state,"original.asar");Check(Engine.Hash(original)==receipt.Manifest.OriginalAsarSha256,"ORIGINAL_BACKUP_HASH_MISMATCH");}
        }
        var chromiumMajor=capabilityProbe!=null?capabilityProbe(executable):RuntimeCapabilities(executable,log);Check(chromiumMajor is >=118 and <=999,"UNSUPPORTED_CHROMIUM_VERSION");var pages=ProbePages(root,out var vendorFiles);
        Check(Version.TryParse(pages["packageVersion"]?.GetValue<string>(),out var pagePackage)&&pagePackage.Major==parsed!.Major&&pagePackage.Minor==parsed.Minor&&pagePackage.Build==parsed.Build,"EXECUTABLE_PACKAGE_VERSION_MISMATCH");
        var bootstrap=Read(zip,"windows-vendor-bootstrap.cjs");Check(Hash(bootstrap)==package.BootstrapSha256,"BOOTSTRAP_HASH_MISMATCH");
        var patched=Path.Combine(temp,"patched.asar");var patch=PatchAsar(original,patched,bootstrap,pages["packageVersion"]!.GetValue<string>());var exeHash=Engine.Hash(executable);var patchedHash=Engine.Hash(patched);Check(exeHash==initialExecutableSha256,"EXECUTABLE_CHANGED_DURING_PROBE");
        var runtime=new JsonObject{["schemaVersion"]=1,["executable"]=Path.GetFullPath(executable),["executableVersion"]=fileVersion,["executableSha256"]=exeHash,["asarSha256"]=patchedHash,["chromiumMajor"]=chromiumMajor,["bundledPage"]=pages};
        var runtimeBytes=JsonSerializer.SerializeToUtf8Bytes(runtime,Engine.Json);
        var payloadFiles=new Dictionary<string,string>(package.PayloadFiles){["vendor-runtime-manifest.json"]=Hash(runtimeBytes)};
        var manifest=package with {ExecutableVersion=fileVersion,ExecutableSha256=exeHash,OriginalAsarSha256=patch.OriginalSha256,PatchedAsarSha256=patchedHash,VendorFiles=vendorFiles,PayloadFiles=payloadFiles,RebaseOfficialUpdate=rebase};
        var prepared=Path.Combine(temp,"prepared.zip");File.Copy(packageZip,prepared,true);
        using(var update=ZipFile.Open(prepared,ZipArchiveMode.Update)){
            update.CreateEntryFromFile(patched,"patched.asar",CompressionLevel.NoCompression);
            using var output=update.CreateEntry("helper/vendor-runtime-manifest.json",CompressionLevel.NoCompression).Open();output.Write(runtimeBytes);
        }
        log("结构兼容探测通过: version="+fileVersion+" originalMain="+patch.Main+" pages="+pages["aresVersion"]+"; 本次文件SHA256已锁定，未将本地哈希当作厂商签名。");
        return(manifest,prepared);
    }
}

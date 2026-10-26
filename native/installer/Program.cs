using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace TripVendorInstaller;
static class Program {
    static string logPath=Path.Combine(Path.GetTempPath(),"TripVendorCompanion-Setup-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+".log");
    static void Log(string value){var line=DateTimeOffset.Now.ToString("O")+" "+value;Console.WriteLine(line);File.AppendAllText(logPath,line+Environment.NewLine,new UTF8Encoding(false));}
    static bool Elevated()=>new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
    static string CurrentUser()=>WindowsIdentity.GetCurrent().User?.Value??throw new InvalidOperationException("WINDOWS_USER_IDENTITY_UNAVAILABLE");
    static int Run(string operation,string target,bool forceExit,string initiatingUser){
        if(forceExit&&operation=="check")throw new ArgumentException("FORCE_EXIT_NOT_ALLOWED_FOR_CHECK");
        string? temp=null;
        try{
            var root=InstallerTarget.Validate(target);
            InstallerTarget.ValidateForceExitIdentity(forceExit,initiatingUser,CurrentUser());
            // Capability probing starts the selected executable. Never do that as administrator
            // when ordinary users can replace the executable or its local dependencies.
            if(Elevated())TargetPrivileges.AssertSafeForElevatedProbe(root);
            var processes=new ClientProcessGuard(root,Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),new WindowsClientProcesses(),Log,Environment.ProcessPath,Environment.ProcessId);
            void Idle()=>processes.AssertIdle();
            // Assign only after atomic private creation succeeds; failure must not
            // send cleanup through a pre-existing or substituted directory.
            temp=PrivateDirectory.CreateStaging();
            var zipPath=Path.Combine(temp,"payload.zip");
            using(var metadataResource=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload-archive.json")??throw new InvalidDataException("INSTALLER_PAYLOAD_METADATA_MISSING")){
                if(metadataResource.Length is <=0 or >4096)throw new InvalidDataException("PAYLOAD_ARCHIVE_METADATA_INVALID");
                var metadata=JsonSerializer.Deserialize<PayloadArchiveMetadata>(metadataResource,Engine.Json)??throw new InvalidDataException("PAYLOAD_ARCHIVE_METADATA_INVALID");
                using var resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip.br")??throw new InvalidDataException("INSTALLER_PAYLOAD_MISSING");
                PayloadArchive.Extract(resource,zipPath,metadata);
            }
            Manifest manifest;using(var zip=ZipFile.OpenRead(zipPath))using(var input=(zip.GetEntry("manifest.json")??throw new InvalidDataException("INSTALLER_MANIFEST_MISSING")).Open())manifest=JsonSerializer.Deserialize<Manifest>(input,Engine.Json)??throw new InvalidDataException("INSTALLER_MANIFEST_INVALID");
            if(manifest.Kind!="trip-vendor-windows-injection-v1")throw new InvalidDataException("INSTALLER_KIND_INVALID");
            if(forceExit)processes.ForceExit();
            Idle();InstallerTarget.Validate(root);
            var prepared=DynamicPackage.Prepare(root,zipPath,temp,Log,operation);manifest=prepared.Manifest;zipPath=prepared.Zip;
            Log("operation="+operation+" target="+root+" version="+manifest.ExecutableVersion);
            new Engine(root,manifest,Idle,Log).Execute(operation,zipPath);return 0;
        }catch(Exception error){Log("失败: "+error.Message);return 1;}
        finally{if(temp!=null)try{Directory.Delete(temp,true);}catch{Log("暂存目录待清理: "+temp);}}
    }
    static bool Elevate(string operation,string root,bool forceExit,string initiatingUser){
        if(Elevated()||!TargetPrivileges.NeedsElevation(root))return false;
        // Validate the protected target before showing UAC, then repeat in the elevated child.
        TargetPrivileges.AssertSafeForElevatedProbe(root);
        var info=new ProcessStartInfo(Environment.ProcessPath!){UseShellExecute=true,Verb="runas"};
        foreach(var argument in InstallerTarget.ElevationArguments(operation,root,logPath,forceExit,initiatingUser))info.ArgumentList.Add(argument);
        using var child=Process.Start(info);child?.WaitForExit();Environment.ExitCode=child?.ExitCode??1;return true;
    }
    sealed record TargetChoice(InspectionResult Inspection){
        public string Root=>Inspection.Root;
        public override string ToString()=>Root+"（"+Inspection.Source+"）";
    }
    [STAThread] static int Main(string[] args){
        Console.OutputEncoding=new UTF8Encoding(false);
        try{
            var options=InstallerOptions.Parse(args);if(options.Log!=null)logPath=options.Log;
            if(options.Inspect){var report=options.Root==null?InstallationInspection.Discover():new InspectionReport(DateTimeOffset.Now,[InstallationInspection.Inspect(options.Root)],[]);Console.WriteLine(JsonSerializer.Serialize(report,Engine.Json));return 0;}
            var initiatingUser=options.InitiatingUser??CurrentUser();
            if(options.Action!=""){
                var root=InstallerTarget.Resolve(options.Root,options.Root==null?InstallationInspection.Discover():new(DateTimeOffset.Now,[],[]));
                if(options.Action!="check"&&Elevate(options.Action,root,options.ForceExit,initiatingUser))return Environment.ExitCode;
                return Run(options.Action,root,options.ForceExit,initiatingUser);
            }
            ApplicationConfiguration.Initialize();
            var packageVersion=InspectionPresentation.PackageVersion(Assembly.GetExecutingAssembly());
            using var form=new Form{Text="旅游商家助手 · 资源注入安装",ClientSize=new System.Drawing.Size(800,805),StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false};
            var intro=new Label{Left=22,Top=20,Width=755,Height=80,Text="一次安装，之后直接打开原旅游商家桌面版。\n\n自动侦测本机客户端；未找到时可手动选择安装目录。支持 1.2.11 及以后结构兼容版本。\n安装和卸载前，请完全退出客户端、助手与官方更新程序。"};
            var targetLabel=new Label{Left=22,Top=119,Width=76,Height=25,Text="客户端目录"};
            var targets=new ComboBox{Left=102,Top=114,Width=554,Height=30,DropDownStyle=ComboBoxStyle.DropDownList,DropDownWidth=900};
            var browse=new Button{Left=668,Top=111,Width=108,Height=32,Text="手动选择…"};
            var targetNote=new Label{Left=22,Top=151,Width=755,Height=35,Text="正在自动侦测客户端安装目录……"};
            var inspection=new TextBox{Left=22,Top=270,Width=755,Height=250,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,Text="正在检测本机客户端……"};
            var refresh=new Button{Left=22,Top=230,Width=190,Height=30,Text="自动侦测 / 刷新状态"};
            var inspectionNote=new Label{Left=228,Top=236,Width=350,Height=25,Text="只读检测，可保持客户端运行。"};
            var details=new CheckBox{Left=606,Top=232,Width=170,Height=25,Text="完整检测详情"};
            var output=new TextBox{Left=22,Top=532,Width=755,Height=170,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,Text="操作日志路径（可选中复制）："+Environment.NewLine+logPath};
            void ShowOutput(string value,bool forceScroll=false){
                var changed=!string.Equals(output.Text,value,StringComparison.Ordinal);
                if(changed)output.Text=value;
                if(changed||forceScroll){output.SelectionStart=output.TextLength;output.SelectionLength=0;output.ScrollToCaret();}
            }
            var note=new Label{Left=22,Top=719,Width=755,Height=65,Text="保留官方原始备份与安装收据；卸载保留登录和客户数据。\n普通用户可写目录直接安装；受保护目录按需提权。未知官方更新或文件漂移会停止操作。\n切换 Windows 用户提权时请手动退出客户端。日志路径见上方文本框。"};
            bool inspecting=false,operationBusy=false,updatingTargets=false,explicitSelection=options.Root!=null;
            string? selectedRoot=options.Root,manualRoot=options.Root;
            InspectionReport? lastReport=null;
            var operationButtons=new List<Button>();
            void RenderInspection(){if(lastReport!=null)inspection.Text=InspectionPresentation.Render(lastReport,(targets.SelectedItem as TargetChoice)?.Inspection,packageVersion,details.Checked);}
            void UpdateButtons(){
                var choice=targets.SelectedItem as TargetChoice;
                var selected=choice!=null&&string.Equals(choice.Root,selectedRoot,StringComparison.OrdinalIgnoreCase);
                refresh.Enabled=browse.Enabled=targets.Enabled=!inspecting&&!operationBusy;
                foreach(var button in operationButtons)button.Enabled=!inspecting&&!operationBusy&&selected;
                if(operationButtons.Count>0){
                    var advice=selected?InspectionPresentation.Advice(choice!.Inspection,packageVersion):null;
                    operationButtons[0].Text=advice?.ButtonText??"注入助手";
                    operationButtons[0].Enabled=!inspecting&&!operationBusy&&selected&&advice!.CanInstall;
                }
            }
            void ShowTargetNote()=>targetNote.Text=selectedRoot!=null?"本次操作目标："+selectedRoot:"未选定客户端：请从列表明确选择，或点击「手动选择」。";
            targets.SelectedIndexChanged+=(_,_)=>{if(updatingTargets)return;selectedRoot=(targets.SelectedItem as TargetChoice)?.Root;explicitSelection=true;ShowTargetNote();RenderInspection();UpdateButtons();};
            details.CheckedChanged+=(_,_)=>{if(!inspecting)RenderInspection();};
            async Task RefreshInspection(){
                if(inspecting)return;inspecting=true;UpdateButtons();inspection.Text="正在读取客户端与助手文件并校验哈希，请稍候……";
                try{var report=await Task.Run(()=>{var found=InstallationInspection.Discover();
                    foreach(var candidate in InspectionPresentation.SupplementalRoots(found,manualRoot,selectedRoot))found.Installations.Add(InstallationInspection.Inspect(candidate.Root,candidate.Source));
                    return found;});if(form.IsDisposed)return;
                    report=InspectionPresentation.WithSelectionContext(report,manualRoot,selectedRoot);
                    var selected=InspectionPresentation.Select(report,selectedRoot,explicitSelection);
                    // Once a target was selected, losing it requires a new explicit choice.
                    if(selectedRoot!=null&&selected==null)explicitSelection=true;
                    updatingTargets=true;targets.Items.Clear();lastReport=report;
                    foreach(var item in InspectionPresentation.Choices(report))targets.Items.Add(new TargetChoice(item));
                    var chosen=targets.Items.Cast<TargetChoice>().FirstOrDefault(p=>ReferenceEquals(p.Inspection,selected));
                    targets.SelectedItem=chosen;selectedRoot=chosen?.Root;updatingTargets=false;ShowTargetNote();
                    RenderInspection();
                }catch(Exception error){if(!form.IsDisposed){updatingTargets=true;targets.Items.Clear();selectedRoot=null;explicitSelection=true;lastReport=null;ShowTargetNote();inspection.Text="检测失败："+error.Message+Environment.NewLine+"已停用旧操作目标；请刷新后重新选择客户端。";}}finally{updatingTargets=false;inspecting=false;if(!form.IsDisposed)UpdateButtons();}
            }
            browse.Click+=async(_,_)=>{using var picker=new FolderBrowserDialog{Description="请选择包含旅游商家桌面版.exe 的客户端安装目录",UseDescriptionForTitle=true,ShowNewFolderButton=false};if(picker.ShowDialog(form)!=DialogResult.OK)return;manualRoot=picker.SelectedPath;selectedRoot=manualRoot;explicitSelection=true;await RefreshInspection();};
            refresh.Click+=async(_,_)=>await RefreshInspection();form.Shown+=async(_,_)=>await RefreshInspection();
            var names=new[]{("注入助手","install"),("卸载并恢复原资源","uninstall"),("恢复中断安装","recover")};
            using var poll=new System.Windows.Forms.Timer{Interval=500};poll.Tick+=(_,_)=>{try{if(File.Exists(logPath))ShowOutput(File.ReadAllText(logPath));}catch{}};
            for(var i=0;i<names.Length;i++){
                var operation=names[i];var button=new Button{Left=22+i*255,Top=188,Width=245,Height=34,Text=operation.Item1};operationButtons.Add(button);
                button.Click+=async(_,_)=>{if(operationBusy||inspecting||selectedRoot==null)return;string root;
                    try{root=InstallerTarget.Validate(selectedRoot);}catch(Exception error){MessageBox.Show(form,error.Message,"请选择有效客户端目录",MessageBoxButtons.OK,MessageBoxIcon.Warning);return;}
                    var choice=ClientExitChoice.Show(form);if(choice is not (DialogResult.Yes or DialogResult.No))return;var force=choice==DialogResult.No;operationBusy=true;UpdateButtons();try{
                        ShowOutput("正在处理客户端目录："+root+Environment.NewLine+"正在校验和处理资源，请稍候……",true);poll.Start();
                        var code=await Task.Run(()=>{if(Elevate(operation.Item2,root,force,initiatingUser))return Environment.ExitCode;return Run(operation.Item2,root,force,initiatingUser);});
                        if(File.Exists(logPath))ShowOutput(File.ReadAllText(logPath),true);
                        if(code==0&&operation.Item2=="install")InstallCompleteDialog.Show(form,root,Elevated(),Log);
                        else MessageBox.Show(form,code==0?"操作完成。日常请打开所选目录中的原旅游商家桌面版。":"操作未完成，请查看下方日志；没有通过校验的资源不会被覆盖。","旅游商家助手",MessageBoxButtons.OK,code==0?MessageBoxIcon.Information:MessageBoxIcon.Warning);
                    }catch(Exception error){ShowOutput(error.Message,true);}finally{poll.Stop();await RefreshInspection();operationBusy=false;UpdateButtons();}};
                form.Controls.Add(button);
            }
            form.Controls.AddRange([intro,targetLabel,targets,browse,targetNote,refresh,inspectionNote,details,inspection,output,note]);UpdateButtons();Application.Run(form);return 0;
        }catch(Exception error){Log(error.Message);return 1;}
    }
}

using System.Diagnostics;
using System.Windows.Forms;

namespace TripVendorInstaller;

static class InstallCompleteDialog {
    internal static void Show(IWin32Window owner,string installedRoot,bool elevated,Action<string> log){
        using var dialog=new Form{Text="助手注入完成",ClientSize=new System.Drawing.Size(600,235),StartPosition=FormStartPosition.CenterParent,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false};
        var text=new Label{Left=20,Top=20,Width=560,Height=55,Text="助手已成功注入。现在可以打开旅游商家客户端。\n日常仍可通过原来的客户端快捷方式启动。"};
        var target=new TextBox{Left=20,Top=82,Width=560,Height=55,Multiline=true,ReadOnly=true,Text=installedRoot};
        var open=new Button{Left=20,Top=165,Width=350,Height=42,Text="立即打开旅游商家客户端"};
        var later=new Button{Left=390,Top=165,Width=190,Height=42,Text="稍后打开",DialogResult=DialogResult.Cancel};
        open.Click+=(_,_)=>{
            open.Enabled=false;
            try{
                // Revalidate the captured installation, never the current discovery/selection.
                var root=InstallerTarget.Validate(installedRoot);
                var executable=Path.Combine(root,InstallerTarget.Executable);
                var start=new ProcessStartInfo(executable){UseShellExecute=true,WorkingDirectory=root};
                if(elevated){
                    // Ask the existing desktop shell to open the client in the user's session.
                    // Do not directly inherit the installer's administrator token.
                    start.FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe");
                    start.ArgumentList.Add(executable);
                }
                using var process=Process.Start(start);
                log("已请求打开旅游商家客户端: "+executable);
                dialog.DialogResult=DialogResult.OK;
                dialog.Close();
            }catch(Exception error){
                log("打开客户端失败: "+error.Message);
                MessageBox.Show(dialog,"助手已注入，但未能打开客户端。可以重试，或通过原快捷方式手动打开。\n\n"+error.Message,"打开客户端失败",MessageBoxButtons.OK,MessageBoxIcon.Warning);
                open.Enabled=true;
            }
        };
        dialog.Controls.AddRange([text,target,open,later]);
        dialog.AcceptButton=later;dialog.CancelButton=later;dialog.ActiveControl=later;
        dialog.ShowDialog(owner);
    }
}

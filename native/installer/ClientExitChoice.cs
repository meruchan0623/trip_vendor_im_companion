using System.Windows.Forms;

namespace TripVendorInstaller;
static class ClientExitChoice {
    // Closing the dialog, Esc and the default Enter action all cancel without UAC or mutation.
    public static DialogResult Show(IWin32Window owner){
        using var dialog=new Form{Text="操作前请退出客户端",ClientSize=new System.Drawing.Size(660,215),StartPosition=FormStartPosition.CenterParent,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false};
        var text=new Label{Left=20,Top=20,Width=620,Height=110,Text="安装、卸载或恢复前，需要完全退出旅游商家桌面版、助手和官方更新程序。\n\n强制退出可能丢失尚未发送的草稿和未保存的内容。请先保存重要内容，再选择继续方式。"};
        var manual=new Button{Left=20,Top=150,Width=200,Height=40,Text="我已手动退出，继续",DialogResult=DialogResult.Yes};
        var force=new Button{Left=230,Top=150,Width=200,Height=40,Text="强制退出后继续",DialogResult=DialogResult.No};
        var cancel=new Button{Left=440,Top=150,Width=200,Height=40,Text="取消",DialogResult=DialogResult.Cancel};
        dialog.Controls.AddRange([text,manual,force,cancel]);dialog.AcceptButton=cancel;dialog.CancelButton=cancel;dialog.ActiveControl=cancel;dialog.Shown+=(_,_)=>cancel.Select();
        return dialog.ShowDialog(owner);
    }
}

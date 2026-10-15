using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using System.Threading.Channels;

internal static partial class Program {
 static async Task ListenInstance(){
  while(!lifetime.IsCancellationRequested)try{
   using var pipe=new NamedPipeServerStream(pipeName,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
   await pipe.WaitForConnectionAsync(lifetime.Token);
   using var deadline=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);deadline.CancelAfter(1500);
   var bytes=new byte[32];int count=0;
   while(count<bytes.Length){int n=await pipe.ReadAsync(bytes.AsMemory(count,1),deadline.Token);if(n==0)break;count+=n;if(bytes[count-1]==10)break;}
   if(Encoding.UTF8.GetString(bytes,0,count)=="OPEN_SETTINGS\n")dispatcher.BeginInvoke(ShowSettings);
  }catch(OperationCanceledException){}catch{await Task.Delay(500);}
 }
 static bool OldHostRunning(){
  foreach(var p in Process.GetProcesses())using(p)try{
   if(p.Id==Environment.ProcessId)continue;
   string name=p.ProcessName;
   if(name.Equals("Travel Merchant Companion",StringComparison.OrdinalIgnoreCase)||name.Equals("旅游商家助手",StringComparison.OrdinalIgnoreCase))return true;
   // Only the development Electron under this project is a competing host.
   if(name.Equals("electron",StringComparison.OrdinalIgnoreCase)){string? executable=p.MainModule?.FileName;string candidate=Path.GetFullPath(Path.Combine(root,"..","..","node_modules","electron","dist","electron.exe"));if(string.Equals(executable,candidate,StringComparison.OrdinalIgnoreCase))return true;}
  }catch{}
  return false;
 }
 static int queuedLines,queueFailed;
 static void QueueChildLine(Process owned,string line){
  if(quitting||child!=owned||Volatile.Read(ref queueFailed)!=0)return;
  if(Interlocked.Increment(ref queuedLines)>128){Interlocked.Decrement(ref queuedLines);if(Interlocked.Exchange(ref queueFailed,1)==0)dispatcher.BeginInvoke(()=>{if(child==owned&&!quitting)_=Shutdown();});return;}
  try{dispatcher.BeginInvoke(()=>{try{if(child==owned&&!quitting)Handle(line);}finally{Interlocked.Decrement(ref queuedLines);}});}catch{Interlocked.Decrement(ref queuedLines);}
 }
 static void StartChild(){
  if(quitting)return;
  if(!smoke&&OldHostRunning()){SetStatus("检测到旧版 Electron 助手，请先退出旧版，再退出并重启本程序。");ShowSettings();return;}
  string node=Path.Combine(root,"runtime","node.exe"), entry=Path.Combine(root,"host","main.cjs");
  if(!File.Exists(node)||!File.Exists(entry)){SetStatus("运行包不完整：缺少 runtime/node.exe 或 host/main.cjs");ShowSettings();return;}
  try{
   var info=new ProcessStartInfo(node){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root,StandardInputEncoding=new UTF8Encoding(false),StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
   if(compactHeap)info.ArgumentList.Add("--max-semi-space-size=4");
   info.ArgumentList.Add(entry);if(acceptance)info.ArgumentList.Add("--memory-metrics");if(smoke)info.ArgumentList.Add("--smoke-test");info.Environment["TRAVEL_RESIDENT_PARENT_PID"]=Environment.ProcessId.ToString();
   Interlocked.Exchange(ref queueFailed,0);
   var launched=new Process{StartInfo=info,EnableRaisingEvents=true};child=launched;
   int exitHandled=0;
   launched.Exited+=(_,_)=>{
    if(Interlocked.Exchange(ref exitHandled,1)!=0)return;
    dispatcher.BeginInvoke(async ()=>{
     if(child!=launched||quitting)return;
     output?.Writer.TryComplete();child=null;target=0;instance=null;boundProcess?.Dispose();boundProcess=null;lastState=null;
     launched.Dispose();SetStatus("后台已停止，等待有限重试");
     if(++restarts<=3){await Task.Delay(1000*restarts*restarts);if(!quitting)StartChild();}
     else SetStatus("后台连续异常停止，请退出后重新启动。");
    });
   };
   launched.Start();
   output=Channel.CreateBounded<string>(new BoundedChannelOptions(64){SingleReader=true,SingleWriter=true,FullMode=BoundedChannelFullMode.Wait});outputTask=WriteOutput(launched,output);
   _=ReadBounded(launched.StandardOutput,line=>QueueChildLine(launched,line));
   // Never expose stderr text: diagnostics may include URLs, orders or credentials.
   _=ReadBounded(launched.StandardError,_=>{});
  }catch{try{child?.Kill(false);}catch{}SetStatus("无法启动后台，请检查运行包。");ShowSettings();}
 }
 static async Task ReadBounded(StreamReader reader,Action<string> deliver){
  char[] buffer=new char[1024];var line=new StringBuilder();bool overflow=false;
  try{int n;while((n=await reader.ReadAsync(buffer))>0){for(int i=0;i<n;i++){char c=buffer[i];if(c=='\n'){if(!overflow)deliver(line.ToString());line.Clear();overflow=false;}else if(c!='\r'&&!overflow){if(line.Length>=65536){line.Clear();overflow=true;}else line.Append(c);}}}}catch{}
 }
 static void Handle(string line){
  string? id=null;
  try{
   using var doc=JsonDocument.Parse(line);var m=doc.RootElement;
   if(m.ValueKind!=JsonValueKind.Object||m.GetProperty("protocolVersion").GetString()!=Version)return;
   if(m.TryGetProperty("requestId",out var req)&&req.ValueKind==JsonValueKind.String){id=req.GetString();if(id?.Length>128)return;}
   string? type=m.GetProperty("type").GetString();var p=m.GetProperty("payload");
   if(p.ValueKind!=JsonValueKind.Object){Error(id,"invalid_command");return;}
   LogSafe(type,p);
   switch(type){
    case "hostState":
     string Safe(string key)=>p.TryGetProperty(key,out var v)&&v.ValueKind==JsonValueKind.String&&v.GetString() is string s&&s.Length<100?s:"unknown";
     bool attached=p.TryGetProperty("attached",out var a)&&a.ValueKind==JsonValueKind.True;
     SetStatus($"客户端：{(attached?"已连接":"未连接")}\r\n登录：{Chinese(Safe("auth"))}\r\n翻译：{Chinese(Safe("phase"))}\r\n原生监测：{Chinese(Safe("nativeStatus"))}");
     if(smoke&&p.TryGetProperty("autoTranslate",out var testAuto)&&testAuto.ValueKind==JsonValueKind.False)smokeResults.Add("autoTranslateFalse");
     syncSettings=true;try{if(languageChoice!=null&&p.TryGetProperty("language",out var lang))languageChoice.SelectedItem=lang.GetString();if(autoChoice!=null&&p.TryGetProperty("autoTranslate",out var au))autoChoice.Checked=au.ValueKind==JsonValueKind.True;if(shortcutChoice!=null&&p.TryGetProperty("shortcutEnabled",out var sh))shortcutChoice.Checked=sh.ValueKind==JsonValueKind.True;}finally{syncSettings=false;}break;
    case "hostReady":if(smoke){Action("status");Action("updateSettings",new{autoTranslate=false});_=Task.Run(async()=>{await Task.Delay(15000);if(!quitting)dispatcher.BeginInvoke(async()=>await Shutdown());});}break;
    case "hostStopped":case "hostMetrics":break;
    case "hostResult":
     if(p.TryGetProperty("ok",out var ok)&&ok.ValueKind==JsonValueKind.False)SetStatus("操作未完成，请检查登录与客户端状态。"+SafeCode(p));
     if(smoke&&ok.ValueKind==JsonValueKind.True&&id!=null){smokeResults.Add(id);if(smokeResults.Contains("status")&&smokeResults.Contains("updateSettings")&&smokeResults.Contains("autoTranslateFalse")){File.WriteAllText(Path.Combine(root,"native-node-smoke.json"),JsonSerializer.Serialize(new{passed=true,status=true,updateSettings=true,customerSend=false}));_=Shutdown();}}break;
    case "hostOpenLogin":
     if(p.TryGetProperty("url",out var url)&&url.GetString()=="https://csagent.tsim.tech/login")Process.Start(new ProcessStartInfo("https://csagent.tsim.tech/login"){UseShellExecute=true});break;
    case "listWindows":Emit("windows",new{windows=Windows()},id);break;
    case "bindWindow":
     var requested=p.GetProperty("targetInstanceId").GetString();var window=Windows().SingleOrDefault(w=>w.TargetInstanceId==requested);
     if(window==null){Error(id,"target_not_found");break;}
     boundProcess?.Dispose();boundProcess=Process.GetProcessById(window.ProcessId);_=boundProcess.SafeHandle;
     target=(nint)window.Handle;instance=window.TargetInstanceId;generation++;lastState=null;EmitWindowState(id);break;
    case "unbindWindow":target=0;instance=null;boundProcess?.Dispose();boundProcess=null;generation++;lastState=null;Emit("windowState",new{bound=false,reason="unbound"},id);break;
    case "probeCapabilities":Emit("capabilities",new{windowFollow=true,readMessage=false,readOrder=false,readDraft=false,writeDraft=false,reason="verified_editor_required"},id);break;
    case "readDraft":case "replaceDraft":Error(id,"verified_editor_required");break;
    case "setCompanionWindows":if(p.GetProperty("handles").GetArrayLength()==0)Emit("companionsRegistered",new{},id);else Error(id,"unsupported_command");break;
    case "stop":Emit("stopped",new{},id);break;
    default:Error(id,"unsupported_command");break;
   }
  }catch{Error(id,"invalid_command");}
 }
 static async Task Shutdown(){
  if(quitting)return;quitting=true;output?.Writer.TryWrite(JsonSerializer.Serialize(new{protocolVersion=Version,type="hostAction",requestId=Guid.NewGuid().ToString(),payload=new{action="quit"}},JsonOptions));tray.Visible=false;
  var owned=child;
  if(owned!=null)try{output?.Writer.TryComplete();if(outputTask!=null)try{await outputTask.WaitAsync(TimeSpan.FromSeconds(1));}catch{}owned.StandardInput.BaseStream.Close();using var timeout=new CancellationTokenSource(10000);await owned.WaitForExitAsync(timeout.Token);}catch{try{if(!owned.HasExited)owned.Kill(false);}catch{}}
  Application.ExitThread();
 }
 static void ShowSettings(){
  if(settings!=null&&!settings.IsDisposed){ShowSettingsWindow(settings);return;}
  var form=new Form{Text="旅游商家助手 · 轻量宿主",Width=520,Height=640,StartPosition=FormStartPosition.CenterScreen,AutoScaleMode=AutoScaleMode.Dpi};settings=form;
  var layout=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(16),AutoScroll=true};form.Controls.Add(layout);
  var exitButton=new Button{Text="退出助手",Width=220,Height=32};
  exitButton.Click+=async (_,_)=>{exitButton.Enabled=false;await Shutdown();};layout.Controls.Add(exitButton);
  statusLabel=new Label{Text=status,Width=460,Height=100};layout.Controls.Add(statusLabel);
  void Button(string text,string action){var b=new Button{Text=text,Width=220,Height=32};b.Click+=(_,_)=>Action(action);layout.Controls.Add(b);}
  Button("登录翻译服务","openLogin");Button("重新读取登录状态","refreshSession");Button("启动商家客户端","startClient");Button("连接客服页面","connect");
  var choices=new FlowLayoutPanel{Width=460,Height=40};var pause=new Button{Text="暂停翻译"};pause.Click+=(_,_)=>Action("pause");var resume=new Button{Text="恢复翻译"};resume.Click+=(_,_)=>Action("resume");choices.Controls.Add(pause);choices.Controls.Add(resume);layout.Controls.Add(choices);
  var language=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=220};languageChoice=language;language.Items.AddRange(new object[]{"zh-TW","en","ja","ko","th","vi","id","ms","fr","de","es","pt","it","ru","ar"});language.SelectedIndexChanged+=(_,_)=>{if(!syncSettings&&language.SelectedItem!=null)Action("updateSettings",new{language=language.SelectedItem.ToString()});};layout.Controls.Add(new Label{Text="手动目标语言（修改后生效）",Width=300});layout.Controls.Add(language);
  Button("恢复自动跟随客户语言","followCustomerLanguage");
  autoChoice=new CheckBox{Text="输入后自动翻译",Width=300};autoChoice.CheckedChanged+=(_,_)=>{if(!syncSettings)Action("updateSettings",new{autoTranslate=autoChoice.Checked});};layout.Controls.Add(autoChoice);
  shortcutChoice=new CheckBox{Text="启用草稿替换快捷键",Width=300};shortcutChoice.CheckedChanged+=(_,_)=>{if(!syncSettings)Action("updateSettings",new{shortcutEnabled=shortcutChoice.Checked});};layout.Controls.Add(shortcutChoice);
  form.FormClosed+=(_,_)=>{settings=null;statusLabel=null;languageChoice=null;autoChoice=null;shortcutChoice=null;};ShowSettingsWindow(form);Action("status");
 }
 static void ShowSettingsWindow(Form form){
  form.Show();
  // STARTUPINFO(SW_HIDE) may consume the first WinForms Show. A user-requested
  // settings window must use an explicit subsequent show, not SW_SHOWDEFAULT.
  int command=Native.IsIconic(form.Handle)?9:5; // SW_RESTORE / SW_SHOW
  Native.ShowWindow(form.Handle,command);
  if(!Native.IsWindowVisible(form.Handle))Native.ShowWindow(form.Handle,command);
  form.Activate();
 }
 static string SafeCode(JsonElement value){
  if(value.TryGetProperty("code",out var c)&&c.ValueKind==JsonValueKind.String&&c.GetString() is string code&&System.Text.RegularExpressions.Regex.IsMatch(code,"^[A-Za-z_]{1,80}$"))return "（"+code+"）";
  return "";
 }
 static void LogSafe(string? type,JsonElement payload){
  if(!acceptance||type is not ("hostState" or "hostResult" or "hostReady" or "hostStopped" or "hostMetrics"))return;
  try{
   var safe=new Dictionary<string,object?>{{"at",DateTimeOffset.UtcNow.ToString("O")},{"type",type}};
   if(type=="hostMetrics"){
    foreach(string key in new[]{"rss","heapTotal","heapUsed","external","arrayBuffers","heapSizeLimit","totalPhysicalSize"})
     if(payload.TryGetProperty(key,out var number)&&number.ValueKind==JsonValueKind.Number&&number.TryGetInt64(out long bytes)&&bytes>=0)safe[key]=bytes;
   }else{
   foreach(string key in new[]{"attached","translationPaused","hasPreview","autoTranslate","shortcutEnabled","followCustomerLanguage","ok","clean"})
    if(payload.TryGetProperty(key,out var b)&&b.ValueKind is JsonValueKind.True or JsonValueKind.False)safe[key]=b.GetBoolean();
   foreach(string key in new[]{"auth","phase","composerSource","nativeStatus","orderStatus","language","code","errorCode"})
    if(payload.TryGetProperty(key,out var e)&&e.ValueKind==JsonValueKind.String&&e.GetString() is string text&&System.Text.RegularExpressions.Regex.IsMatch(text,"^[A-Za-z_-]{1,80}$"))safe[key]=text;
   }
   string folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TravelMerchantResident","logs");Directory.CreateDirectory(folder);
   string path=Path.Combine(folder,"acceptance.jsonl");if(File.Exists(path)&&new FileInfo(path).Length>524288)File.Move(path,path+".previous",true);
   File.AppendAllText(path,JsonSerializer.Serialize(safe)+"\n",new UTF8Encoding(false));
  }catch{}
 }
 static string Chinese(string code)=>code switch{"ready"=>"就绪","needs_login"=>"需要登录","idle"=>"空闲","reading"=>"读取草稿中","translating"=>"翻译中","available"=>"可用","unavailable"=>"不可用","paused"=>"已暂停","error"=>"异常","unknown"=>"等待状态",_=>code};
 static void SelfTest(){
  if(actions.Contains("send")||actions.Contains("replaceDraft"))throw new Exception("unsafe_action");
  var reader=new StringReader("");
  File.WriteAllText(Path.Combine(AppContext.BaseDirectory,"resident-self-test.json"),JsonSerializer.Serialize(new{passed=true,webView=false,customerSend=false,protocol=Version,pipeCurrentUserOnly=true}));
 }
}

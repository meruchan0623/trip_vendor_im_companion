const labels={ready:'已连接本机助手',connecting:'正在连接，等待本机助手',disconnected:'尚未连接本机助手'};
async function refresh(action='getBridgeStatus'){
  try{
    const status=await chrome.runtime.sendMessage({action});
    if(!status||!Object.hasOwn(labels,status.state))throw Error('请在扩展管理页重新加载 TSim 会话桥，然后刷新本页。');
    document.querySelector('#state').textContent=labels[status.state];document.querySelector('#error').textContent=typeof status.error==='string'?status.error:'';
  }catch(error){document.querySelector('#state').textContent='无法读取会话桥后台状态';document.querySelector('#error').textContent=error.message;}
}
document.querySelector('#retry').addEventListener('click',()=>void refresh('retryBridge'));
void refresh();const poll=setInterval(()=>void refresh(),1000);addEventListener('pagehide',()=>clearInterval(poll),{once:true});

const q=new URLSearchParams(location.search),marker=q.get('marker');
if(!/^[a-f0-9-]{36}$/.test(marker??''))throw Error('INVALID_BROWSER_WINDOW');
document.title=`TSim Companion Order ${marker}`;
const url=new URL('https://csagent.tsim.tech/embed/operator');
for(const key of ['identifier','identifierType','requestId'])url.searchParams.set(key,q.get(key)??'');
url.searchParams.set('source','travel-merchant-companion');
document.querySelector('iframe').src=url.href;

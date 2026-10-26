import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileOutboundWaitStore} from '../electron/outbound-wait-store';
import {parseOutboundWaitBounds} from '../runtime/outbound-wait-bounds';
import {createOutboundWaitController,type OutboundWaitPersisted} from '../runtime/outbound-wait-controller';
const saved=(updatedAt=100):OutboundWaitPersisted=>({v:1,waitMs:450,updatedAt,sent:10,wasted:1,useful:4});
test('wait store serializes atomic writes, isolates accounts and translates wall time across restarts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'outbound-store-')),path=join(directory,'wait.json');let monotonic=100,wall=1_800_000_000_000;
  try{
    const store=new FileOutboundWaitStore(path,()=>monotonic,()=>wall);
    await Promise.all([store.save('psim:7',saved()),store.save('psim:8',{...saved(),waitMs:900})]);
    const records=JSON.parse(await readFile(path,'utf8'));assert.equal(records['psim:7'].updatedAt,wall);
    assert.deepEqual(Object.keys(records['psim:7']).sort(),['sent','updatedAt','useful','v','waitMs','wasted']);
    monotonic=5;wall+=86_400_000;
    assert.equal((await store.load('psim:7'))!.updatedAt,5-86_400_000);
    assert.equal((await store.load('psim:8'))!.waitMs,900);
    if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
    await store.clear('psim:7');assert.equal(await store.load('psim:7'),null);assert.ok(await store.load('psim:8'));
    assert.deepEqual(await readdir(directory),['wait.json']);
    wall+=15*86_400_000;const old=await store.load('psim:8');
    const controller=createOutboundWaitController({clock:{now:()=>monotonic,setTimeout:()=>0,clearTimeout:()=>{}},persisted:old,onDue:()=>{}});
    assert.equal(controller.snapshot().waitMs,800);controller.dispose();
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('wait store rejects extra fields, invalid scopes, oversized files and unknown versions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'outbound-store-')),path=join(directory,'wait.json'),store=new FileOutboundWaitStore(path);
  try{
    await assert.rejects(store.save('__proto__',saved()),/OUTBOUND_WAIT_INVALID/);
    await assert.rejects(store.save('psim:7',{...saved(),draft:'private'} as any),/OUTBOUND_WAIT_INVALID/);
    for(const text of [' '.repeat(131073),JSON.stringify({'psim:7':{...saved(),v:2}}),JSON.stringify({anonymous:saved()}),JSON.stringify({'psim:7':{...saved(),token:'secret'}})]){
      await writeFile(path,text);await assert.rejects(store.load('psim:7'),/OUTBOUND_WAIT_INVALID/);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('optional profile bounds validate integers and preserve legal disjoint ranges',()=>{
  assert.deepEqual(parseOutboundWaitBounds({enabled:false,min_ms:1200,max_ms:2000}),{enabled:false,minMs:1200,maxMs:2000});
  for(const value of [null,[],{}, {enabled:1,min_ms:300,max_ms:1000},{enabled:true,min_ms:300.5,max_ms:1000},{enabled:true,min_ms:1000,max_ms:300},{enabled:true,min_ms:99,max_ms:1000},{enabled:true,min_ms:300,max_ms:3001}])assert.equal(parseOutboundWaitBounds(value),null);
});


test('owned profile boundaries update without identity churn and reset on invalid or missing field',async()=>{
  const {OwnedPsimService}=await import('../host/owned-service');let bounds:unknown={enabled:true,min_ms:500,max_ms:1200};let publications=0;
  const service=new OwnedPsimService(async()=>new Response(JSON.stringify({success:true,data:{id:7,is_active:true,permissions:[],outbound_wait:bounds}})),()=>{publications++;},{load:async()=>({accessToken:'fixture-token',sessionRef:'fixture-ref'}),save:async()=>{},clear:async()=>{}});
  try{
    await service.ensureSession();const identity=service.identity(),before=publications;
    assert.deepEqual(service.outboundWaitBounds(),{enabled:true,minMs:500,maxMs:1200});
    bounds={enabled:false,min_ms:1200,max_ms:2000};await service.ensureSession();assert.deepEqual(service.identity(),identity);assert.equal(publications,before);assert.deepEqual(service.outboundWaitBounds(),{enabled:false,minMs:1200,maxMs:2000});
    bounds={enabled:false,min_ms:'300',max_ms:1000};await service.ensureSession();assert.equal(service.outboundWaitBounds(),null);
    bounds=undefined;await service.ensureSession();assert.equal(service.outboundWaitBounds(),null);
  }finally{service.dispose();}
});

test('optional extension bridge accepts bounds on its whitelist and applies repeat-profile changes without identity churn',async()=>{
  const {BrowserSessionService,parseBrowserSession}=await import('../electron/browser-session');
  const value={accountScope:'psim:7',permissions:[],sessionKey:'a'.repeat(64)+':7'};
  assert.deepEqual(parseBrowserSession(value),value);
  assert.throws(()=>parseBrowserSession({...value,unexpected:'private'}),/INVALID_BROWSER_SESSION/);
  let changes=0;const fixture:any={current:{accountScope:'psim:7',permissions:[],authGeneration:1},sessionKey:value.sessionKey,generation:1,changed(){changes++;},revoke(){this.generation++;this.current=null;this.sessionKey=null;this.waitBounds=null;}};
  (BrowserSessionService.prototype as any).update.call(fixture,{...value,outbound_wait:{enabled:false,min_ms:300,max_ms:1400}});
  assert.equal(changes,0);assert.deepEqual(fixture.waitBounds,{enabled:false,minMs:300,maxMs:1400});assert.equal(fixture.current.authGeneration,1);
  (BrowserSessionService.prototype as any).update.call(fixture,value);assert.equal(fixture.waitBounds,null);assert.equal(changes,0);
});

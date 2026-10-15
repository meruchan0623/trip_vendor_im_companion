import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrderWindowStore,restoreOrderWindow,validOrderWindowState} from '../electron/order-window-state';
const target={x:100,y:100,width:1000,height:800};
const primary={x:0,y:0,width:1920,height:1080};
const secondary={x:-2560,y:0,width:2560,height:1440};
const folders:string[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(folders.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
describe('independent order window DIP restore state',()=>{
  it('starts at 1200 by 900, centered on the client and clamped into its work area',()=>{
    expect(restoreOrderWindow(null,target,[primary])).toEqual({bounds:{x:0,y:50,width:1200,height:900},maximized:false});
    const small={x:2000,y:0,width:1024,height:768};
    expect(restoreOrderWindow(null,{x:2100,y:100,width:800,height:600},[primary,small])).toEqual({bounds:{x:2012,y:40,width:976,height:720},maximized:false});
  });
  it('preserves saved DIP size, negative monitor position and maximized state across launches',()=>{
    const saved={bounds:{x:-2400,y:120,width:1600,height:1100},maximized:true};
    expect(restoreOrderWindow(saved,target,[primary,secondary])).toEqual(saved);
  });
  it('moves a disconnected-monitor window onto the client monitor and clamps its size',()=>{
    const saved={bounds:{x:-2400,y:200,width:2200,height:1300},maximized:true};
    expect(restoreOrderWindow(saved,target,[primary])).toEqual({bounds:primary,maximized:true});
  });
  it('keeps a partly offscreen window fully visible on its saved monitor',()=>{
    const saved={bounds:{x:1800,y:1000,width:1200,height:900},maximized:false};
    expect(restoreOrderWindow(saved,target,[primary,secondary])).toEqual({bounds:{x:720,y:180,width:1200,height:900},maximized:false});
    expect(()=>restoreOrderWindow(null,target,[])).toThrow('DISPLAY_UNAVAILABLE');
  });
  it('rejects untrusted geometry and ignores invalid saved files',async()=>{
    for(const value of [null,{}, {bounds:target,maximized:'true'},{bounds:{...target,x:Infinity},maximized:false},{bounds:{...target,width:319},maximized:false},{bounds:{...target,height:20001},maximized:false}])expect(validOrderWindowState(value)).toBe(false);
    const folder=await mkdtemp(join(tmpdir(),'companion-state-'));folders.push(folder);const path=join(folder,'state.json');
    await writeFile(path,'{broken','utf8');const store=new OrderWindowStore(path);await store.load();expect(store.state).toBeNull();
    await writeFile(path,JSON.stringify({bounds:target,maximized:'true'}),'utf8');await store.load();expect(store.state).toBeNull();
  });
  it('coalesces changes, copies caller geometry and flushes only local window state for next launch',async()=>{
    const folder=await mkdtemp(join(tmpdir(),'companion-state-'));folders.push(folder);const path=join(folder,'nested','state.json'),store=new OrderWindowStore(path);
    await store.load();expect(store.state).toBeNull();
    const first={bounds:{...target},maximized:false};store.update(first);first.bounds.x=9999;
    expect(store.state?.bounds.x).toBe(100);
    const final={bounds:{x:-2200,y:100,width:1200,height:900},maximized:true};store.update(final);store.update({bounds:{...target,width:0},maximized:false});
    await store.flush();expect(JSON.parse(await readFile(path,'utf8'))).toEqual(final);
    const reloaded=new OrderWindowStore(path);await reloaded.load();expect(reloaded.state).toEqual(final);
    expect(Object.keys(reloaded.state!).sort()).toEqual(['bounds','maximized']);
  });
});


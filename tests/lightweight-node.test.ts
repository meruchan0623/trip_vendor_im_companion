import { describe,it,expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { BoundedJsonLines,MAX_LINE_BYTES,parseHostAction,stateProjection,ParentNativeTransport,attachProtocol } from '../host-node/protocol';
import type { StandaloneState } from '../src/shared/companion-api';
import { NativeAdapter } from '../electron/native-adapter';
import { safeDiagnostic, safeCode, stateErrorCode } from '../host-node/diagnostics';

describe('lightweight parent protocol',()=>{
  it('parses split UTF-8 and multiple bounded frames',()=>{const values:unknown[]=[];let failed=false;const p=new BoundedJsonLines(v=>values.push(v),()=>failed=true);const b=Buffer.from('{"text":"中文"}\n{"x":2}\n');for(const byte of b)p.push(Buffer.from([byte]));p.end();expect(values).toEqual([{text:'中文'},{x:2}]);expect(failed).toBe(false);});
  it('rejects oversized unfinished frames before newline',()=>{let failures=0;const p=new BoundedJsonLines(()=>{throw Error('unexpected');},()=>failures++);p.push(Buffer.alloc(MAX_LINE_BYTES+1,32));p.push(Buffer.from('{}\n'));expect(failures).toBe(1);});
  it('rejects malformed UTF8, JSON and partial EOF',()=>{for(const bytes of [Buffer.from([255,10]),Buffer.from('{\n'),Buffer.from('{')]){let failures=0;const p=new BoundedJsonLines(()=>{},()=>failures++);p.push(bytes);p.end();expect(failures).toBe(1);}});
  it('allows fixed settings and rejects send/code/url payloads',()=>{const action=(name:string,extra={})=>({protocolVersion:'1.0',type:'hostAction',requestId:'request-1',payload:{action:name,...extra}});expect(parseHostAction(action('pause'))).not.toBeNull();expect(parseHostAction(action('updateSettings',{options:{language:'ja',autoTranslate:false}}))).not.toBeNull();for(const v of [action('send'),action('openLogin',{url:'https://evil.test'}),action('updateSettings',{options:{language:'bad'}}),action('updateSettings',{options:{script:'eval'}})])expect(parseHostAction(v)).toBeNull();});
  it('projects only non-content state fields',()=>{const state={attached:true,auth:'ready',phase:'ready',composerSource:'verified-editor',nativeStatus:'available',draft:{text:'private draft'},preview:'secret preview',accountScope:'secret account',error:'secret token',language:'en'} as StandaloneState;const result=JSON.stringify(stateProjection(state,'idle'));expect(result).not.toMatch(/private draft|secret|accountScope|draft|"error":/);expect(JSON.parse(result)).toMatchObject({hasPreview:true,attached:true,errorCode:'UNCLASSIFIED'});});
  it('keeps known failure codes while removing location, content and URL fields',()=>{
    const line=safeDiagnostic([JSON.stringify({event:'companion-service-failed',code:'NATIVE_LEASE_ENDED',locations:['secret.ts:2:3'],draft:'PRIVATE',url:'https://secret',token:'TOKEN'})]);
    expect(JSON.parse(line!)).toEqual({event:'companion-service-failed',code:'NATIVE_LEASE_ENDED'});
    expect(safeDiagnostic([JSON.stringify({event:'runtime-invalidated',reason:'NATIVE_EVENT_CDP_DISCONNECTED',body:'SECRET'})])).toBe('{"event":"runtime-invalidated","reason":"NATIVE_EVENT_CDP_DISCONNECTED"}');
  });
  it('rejects unknown events and arbitrary uppercase secrets, not merely formatting them',()=>{
    expect(safeDiagnostic(['customer secret'])).toBeNull();expect(safeDiagnostic(['{"event":"customer-content","code":"NATIVE_LEASE_ENDED"}'])).toBeNull();
    expect(safeCode('PRIVATE_SECRET_TOKEN')).toBe('UNCLASSIFIED');expect(safeCode('https://secret')).toBe('UNCLASSIFIED');expect(safeDiagnostic(['{"event":"action-failed","reason":"PRIVATE_SECRET_TOKEN"}'])).toBe('{"event":"action-failed","reason":"UNCLASSIFIED"}');
  });
  it('extracts only the complete fixed service error template',()=>{
    expect(stateErrorCode(null)).toBeNull();expect(stateErrorCode('操作未完成（NATIVE_LEASE_ENDED），请核对连接后重试。')).toBe('NATIVE_LEASE_ENDED');expect(stateErrorCode('secret（NATIVE_LEASE_ENDED）')).toBe('UNCLASSIFIED');expect(stateErrorCode('操作未完成（PRIVATE_SECRET_TOKEN），请核对连接后重试。')).toBe('UNCLASSIFIED');
  });
  it('routes native frames and ends transport exactly once',async()=>{const written:unknown[]=[];const transport=new ParentNativeTransport(v=>written.push(v));let exits=0;transport.on('exit',()=>exits++);transport.stdin.write('{"type":"listWindows"}\n');expect(written).toEqual([{type:'listWindows'}]);let received='';transport.stdout.on('data',v=>received+=v);transport.receive({type:'windowState'});expect(received).toContain('windowState');transport.kill();transport.kill();expect(exits).toBe(1);});
  it('closes on EOF and does not retain further input',()=>{const input=new PassThrough();let closes=0,received=0;const stop=attachProtocol(input,()=>received++,()=>closes++);input.write('{}\n');input.emit('end');input.emit('data',Buffer.from('{}\n'));expect(closes).toBe(1);expect(received).toBe(1);stop();});
  it('reuses native validation on injected parent transport without spawning a helper',async()=>{
    const states:unknown[]=[];
    const transport=new ParentNativeTransport(value=>{const r=value as {requestId:string;type:string};queueMicrotask(()=>transport.receive({protocolVersion:'1.0',requestId:r.requestId,type:'result',payload:r.type==='listWindows'?{windows:[{targetInstanceId:'10:20:30',displayName:'Vendor'}]}:{}}));});
    const adapter=new NativeAdapter('does-not-exist',s=>states.push(s),()=>{},undefined,undefined,undefined,undefined,()=>transport);
    adapter.start();expect(await adapter.list()).toEqual([{targetInstanceId:'10:20:30',title:'Vendor',processName:'旅游商家桌面版'}]);
    await adapter.bind('10:20:30');transport.receive({protocolVersion:'1.0',type:'windowState',targetInstanceId:'10:20:30',payload:{bounds:{x:0,y:0,width:500,height:500},visible:true,minimized:false,foreground:true,dpi:96}});
    await new Promise(resolve=>setImmediate(resolve));expect(states).toContainEqual(expect.objectContaining({targetInstanceId:'10:20:30',foreground:true}));adapter.stop();
  });
});

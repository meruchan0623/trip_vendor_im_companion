import {afterEach,describe,expect,it} from 'vitest';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,stat,readdir,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {SecureSessionStore} from '../electron/secure-session-store';
const roots:string[]=[];
const key=randomBytes(32);
const crypto={
  isEncryptionAvailable:()=>true,
  encryptString(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);},
  decryptString(value:Buffer){const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8');},
};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'secure-session-'));roots.push(root);const path=join(root,'app','session.enc');return{path,store:new SecureSessionStore(path,crypto)};}
const session={accessToken:'private-access-token',sessionRef:'private-session-reference'};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
describe('SecureSessionStore',()=>{
  it('restores encrypted credentials after a store restart without writing plaintext',async()=>{
    const {path,store}=await fixture();expect(await store.load()).toBeNull();await store.save(session);
    const bytes=await readFile(path);expect(bytes.includes(Buffer.from(session.accessToken))).toBe(false);expect(bytes.includes(Buffer.from(session.sessionRef))).toBe(false);
    expect(await new SecureSessionStore(path,crypto).load()).toEqual(session);
    expect(await readdir(dirname(path))).toEqual(['session.enc']);
    if(process.platform!=='win32'){expect((await stat(path)).mode&0o777).toBe(0o600);expect((await stat(dirname(path))).mode&0o777).toBe(0o700);}
  });
  it('refuses unavailable encryption and Linux plaintext storage without destroying an existing session',async()=>{
    const {path,store}=await fixture();await store.save(session);const before=await readFile(path);
    for(const insecure of [{...crypto,isEncryptionAvailable:()=>false},{...crypto,getSelectedStorageBackend:()=> 'basic_text'}]){
      const unavailable=new SecureSessionStore(path,insecure);
      await expect(unavailable.save(session)).rejects.toThrow('SESSION_STORAGE_ENCRYPTION_UNAVAILABLE');
      await expect(unavailable.load()).rejects.toThrow('SESSION_STORAGE_ENCRYPTION_UNAVAILABLE');
    }
    expect(await readFile(path)).toEqual(before);
  });
  it('reports damaged, unsupported and oversized credentials as controlled errors',async()=>{
    const {path,store}=await fixture();await mkdir(dirname(path),{recursive:true});
    for(const payload of [Buffer.from('broken'),crypto.encryptString(JSON.stringify({version:2,...session})),crypto.encryptString(JSON.stringify({version:1,...session,password:'must-not-appear'})),crypto.encryptString(JSON.stringify({version:1,accessToken:'',sessionRef:'ref'})),Buffer.alloc(128*1024+1)]){
      await writeFile(path,payload);await expect(store.load()).rejects.toThrow('SESSION_STORAGE_CORRUPT');
    }
  });
  it('clears only its own file and treats an absent file as already cleared',async()=>{
    const {path,store}=await fixture();await store.save(session);await writeFile(join(dirname(path),'other'),'keep');
    await store.clear();await store.clear();expect(await store.load()).toBeNull();expect(await readdir(dirname(path))).toEqual(['other']);
  });
  it('serializes concurrent save, clear and load in invocation order',async()=>{
    const {store}=await fixture();const second={accessToken:'new-access',sessionRef:'new-session'};
    const operations=[store.save(session),store.clear(),store.save(second),store.load()];
    expect((await Promise.all(operations))[3]).toEqual(second);
    await Promise.all([store.save(session),store.clear()]);expect(await store.load()).toBeNull();
  });
  it('snapshots credentials and permits operations after a rejected save',async()=>{
    const {store}=await fixture();const mutable={...session};const saving=store.save(mutable);mutable.accessToken='changed';await saving;expect(await store.load()).toEqual(session);
    await expect(store.save({accessToken:'',sessionRef:'ref'})).rejects.toThrow('SESSION_STORAGE_INVALID');await store.save(session);expect(await store.load()).toEqual(session);
  });
});

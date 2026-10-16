import {constants} from 'node:fs';
import {chmod, mkdir, open, rename, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {OwnedSessionStore} from '../host/owned-service';

type StoredSession = {accessToken:string;sessionRef:string};
type SessionCrypto = {
  isEncryptionAvailable():boolean;
  encryptString(value:string):Buffer;
  decryptString(value:Buffer):string;
  getSelectedStorageBackend?():string;
};
const MAX_FILE_BYTES = 128 * 1024;
const fail = (code:string) => new Error(code);
function validSession(value:unknown):value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return ['accessToken','sessionRef'].every(key => typeof data[key] === 'string'
    && data[key].length > 0 && data[key].length <= 16000
    && data[key].trim() === data[key] && !/[\u0000\r\n]/.test(data[key]));
}
function missing(error:unknown):boolean {return (error as NodeJS.ErrnoException)?.code === 'ENOENT';}

/** Stores only session credentials in the companion's own userData directory. */
export class SecureSessionStore implements OwnedSessionStore {
  private queue:Promise<void> = Promise.resolve();
  constructor(private filePath:string, private crypto:SessionCrypto) {}
  private serial<T>(operation:()=>Promise<T>):Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(()=>{},()=>{});
    return result;
  }
  private requireEncryption():void {
    try {
      if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text') {
        throw fail('SESSION_STORAGE_ENCRYPTION_UNAVAILABLE');
      }
    } catch {throw fail('SESSION_STORAGE_ENCRYPTION_UNAVAILABLE');}
  }
  load():Promise<StoredSession|null> {return this.serial(async()=>{
    let file;
    try {file = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));}
    catch (error) {if(missing(error))return null;throw fail('SESSION_STORAGE_READ_FAILED');}
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) throw fail('SESSION_STORAGE_CORRUPT');
      this.requireEncryption();
      // Bounded read protects against files growing after stat.
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytesRead = 0;
      while(bytesRead < bytes.length) {
        const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if(result.bytesRead === 0)break;
        bytesRead += result.bytesRead;
      }
      if(bytesRead === 0 || bytesRead > MAX_FILE_BYTES)throw fail('SESSION_STORAGE_CORRUPT');
      let parsed:unknown;
      try {parsed = JSON.parse(this.crypto.decryptString(bytes.subarray(0,bytesRead)));}
      catch {throw fail('SESSION_STORAGE_CORRUPT');}
      if (!validSession(parsed) || (parsed as StoredSession & {version?:unknown}).version !== 1
        || Object.keys(parsed).sort().join(',') !== 'accessToken,sessionRef,version') throw fail('SESSION_STORAGE_CORRUPT');
      await file.chmod(0o600);
      return {accessToken:parsed.accessToken,sessionRef:parsed.sessionRef};
    } catch(error) {
      if(error instanceof Error && /^SESSION_STORAGE_/.test(error.message))throw error;
      throw fail('SESSION_STORAGE_READ_FAILED');
    } finally {await file.close();}
  });}
  save(session:StoredSession):Promise<void> {
    // Snapshot before enqueue so a caller cannot mutate credentials while waiting.
    const snapshot = validSession(session) ? {accessToken:session.accessToken,sessionRef:session.sessionRef} : null;
    return this.serial(async()=>{
      if(!snapshot)throw fail('SESSION_STORAGE_INVALID');
      this.requireEncryption();
      let encrypted:Buffer;
      try {encrypted = this.crypto.encryptString(JSON.stringify({version:1,...snapshot}));}
      catch {throw fail('SESSION_STORAGE_WRITE_FAILED');}
      if(!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_FILE_BYTES)throw fail('SESSION_STORAGE_WRITE_FAILED');
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      let file;
      try {
        await mkdir(dirname(this.filePath),{recursive:true,mode:0o700});
        await chmod(dirname(this.filePath),0o700);
        file = await open(temporary,'wx',0o600);
        await file.writeFile(encrypted);
        await file.chmod(0o600);
        await file.sync();
        await file.close();file = undefined;
        await rename(temporary,this.filePath);
      } catch {throw fail('SESSION_STORAGE_WRITE_FAILED');}
      finally {await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
    });
  }
  clear():Promise<void> {return this.serial(async()=>{
    try {await unlink(this.filePath);}
    catch(error) {if(!missing(error))throw fail('SESSION_STORAGE_CLEAR_FAILED');}
  });}
}

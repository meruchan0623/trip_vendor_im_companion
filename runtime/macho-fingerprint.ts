import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

/** Fingerprint code/data independently of the bundle resource seal embedded by codesign. */
export function unsignedMachOHash(input:Buffer):string {
  const data=Buffer.from(input);
  if(data.length<32||data.readUInt32LE(0)!==0xfeedfacf)throw new Error('UNSUPPORTED_MACHO');
  const count=data.readUInt32LE(16),size=data.readUInt32LE(20),end=32+size;
  if(count>4096||end>data.length)throw new Error('INVALID_MACHO');
  let offset=32,signatureOffset=0,signatureSize=0,linkedit=0;
  for(let i=0;i<count;i++){
    if(offset+8>end)throw new Error('INVALID_MACHO');
    const command=data.readUInt32LE(offset),length=data.readUInt32LE(offset+4);
    if(length<8||offset+length>end)throw new Error('INVALID_MACHO');
    if(command===0x1d){
      if(length!==16||signatureOffset)throw new Error('INVALID_MACHO_SIGNATURE');
      signatureOffset=data.readUInt32LE(offset+8);signatureSize=data.readUInt32LE(offset+12);
      data.fill(0,offset+8,offset+16);
    }
    if(command===0x19&&length>=72&&data.toString('ascii',offset+8,offset+24).replace(/\0.*$/,'')==='__LINKEDIT')linkedit=offset;
    offset+=length;
  }
  if(offset!==end||!signatureOffset||!signatureSize||signatureOffset<end||signatureOffset+signatureSize!==data.length||!linkedit)throw new Error('INVALID_MACHO_SIGNATURE');
  const fileOffset=Number(data.readBigUInt64LE(linkedit+40));
  if(fileOffset>end&&fileOffset<=signatureOffset){
    data.writeBigUInt64LE(0n,linkedit+32); // vmsize includes the variable-length signature.
    data.writeBigUInt64LE(BigInt(signatureOffset-fileOffset),linkedit+48);
  }else throw new Error('INVALID_MACHO_LINKEDIT');
  return createHash('sha256').update(data.subarray(0,signatureOffset)).digest('hex');
}

export async function fingerprintMacExecutable(path:string):Promise<string>{
  const identity=(s:Awaited<ReturnType<typeof lstat>>)=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink())throw new Error('FINGERPRINT_FILE_UNVERIFIED');
  const data=await readFile(path);
  if(identity(before)!==identity(await lstat(path)))throw new Error('FINGERPRINT_FILE_CHANGED');
  return unsignedMachOHash(data);
}

import {createReadStream,createWriteStream} from 'node:fs';
import {stat,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createBrotliCompress,constants} from 'node:zlib';

export const WINDOWS_PAYLOAD_BROTLI_QUALITY=8;
export const WINDOWS_PAYLOAD_MAXIMUM_BYTES=1024*1024*1024;
export async function compressWindowsPayload(zip,compressed,metadataPath){
  const expectedBytes=(await stat(zip)).size;
  if(expectedBytes<=0||expectedBytes>WINDOWS_PAYLOAD_MAXIMUM_BYTES)throw new Error('PAYLOAD_ARCHIVE_SIZE_UNSUPPORTED');
  const start=performance.now(),zipHash=createHash('sha256'),compressedHash=createHash('sha256');
  let zipBytes=0,compressedBytes=0,created=false;
  const output=createWriteStream(compressed,{flags:'wx'});output.on('open',()=>{created=true;});
  try{
    await pipeline(createReadStream(zip),new Transform({transform(bytes,_encoding,next){zipBytes+=bytes.length;zipHash.update(bytes);next(null,bytes);}}),createBrotliCompress({params:{[constants.BROTLI_PARAM_QUALITY]:WINDOWS_PAYLOAD_BROTLI_QUALITY}}),new Transform({transform(bytes,_encoding,next){compressedBytes+=bytes.length;compressedHash.update(bytes);next(null,bytes);}}),output);
    if(zipBytes!==expectedBytes||compressedBytes<=0||compressedBytes>WINDOWS_PAYLOAD_MAXIMUM_BYTES)throw new Error('PAYLOAD_ARCHIVE_CHANGED_OR_TOO_LARGE');
    const metadata={kind:'zip+brotli-v1',zipBytes,zipSha256:zipHash.digest('hex'),compressedBytes,compressedSha256:compressedHash.digest('hex'),brotliQuality:WINDOWS_PAYLOAD_BROTLI_QUALITY};
    await writeFile(metadataPath,JSON.stringify(metadata,null,2),{flag:'wx'});
    return{...metadata,compressionMs:Math.round(performance.now()-start),savedBytes:zipBytes-compressedBytes};
  }catch(error){if(created)await rm(compressed,{force:true});throw error;}
}

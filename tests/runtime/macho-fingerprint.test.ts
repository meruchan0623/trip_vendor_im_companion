import {describe,it,expect} from 'vitest';
import {unsignedMachOHash} from '../../runtime/macho-fingerprint';
function image(signatureSize=32){
  const b=Buffer.alloc(256+signatureSize);b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(2,16);b.writeUInt32LE(88,20);
  b.writeUInt32LE(0x19,32);b.writeUInt32LE(72,36);b.write('__LINKEDIT',40);b.writeBigUInt64LE(BigInt(signatureSize+128),64);b.writeBigUInt64LE(128n,72);b.writeBigUInt64LE(BigInt(signatureSize+128),80);
  b.writeUInt32LE(0x1d,104);b.writeUInt32LE(16,108);b.writeUInt32LE(256,112);b.writeUInt32LE(signatureSize,116);b.fill(17,128,256);b.fill(42,256);return b;
}
describe('signature independent Mach-O fingerprint',()=>{
  it('accepts re-signing but detects any code or data change',()=>{
    expect(unsignedMachOHash(image(32))).toBe(unsignedMachOHash(image(64)));
    const altered=image();altered[200]^=1;expect(unsignedMachOHash(altered)).not.toBe(unsignedMachOHash(image()));
  });
  it('rejects missing/truncated signatures, malformed load commands and trailing data',()=>{
    const malformed=image();malformed.writeUInt32LE(0,36);
    for(const b of [Buffer.alloc(16),image().subarray(0,260),Buffer.concat([image(),Buffer.from([0])]),malformed])expect(()=>unsignedMachOHash(b)).toThrow();
  });
});

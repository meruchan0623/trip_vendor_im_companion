export const WINDOWS_PAYLOAD_BROTLI_QUALITY:8;
export const WINDOWS_PAYLOAD_MAXIMUM_BYTES:number;
export interface WindowsPayloadArchiveReport {kind:string;zipBytes:number;zipSha256:string;compressedBytes:number;compressedSha256:string;brotliQuality:number;compressionMs:number;savedBytes:number}
export function compressWindowsPayload(zip:string,compressed:string,metadataPath:string):Promise<WindowsPayloadArchiveReport>;

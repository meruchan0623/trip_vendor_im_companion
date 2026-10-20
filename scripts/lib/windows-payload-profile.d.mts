export const WINDOWS_HELPER_LOCALES:readonly string[];
export const WINDOWS_PAYLOAD_ZIP_OPTIONS:readonly string[];
export type WindowsPayloadExclusion='debug-symbol'|'unused-chromium-ui-locale';
export interface WindowsPayloadProfile {
  locales:string[];sourceBytes:number;payloadBytes:number;sourceFiles:number;payloadFiles:number;savedBytes:number;
  excluded:Array<{path:string;bytes:number;reason:WindowsPayloadExclusion}>;
}
export function windowsPayloadExclusion(path:string):WindowsPayloadExclusion|null;
export function copyWindowsHelperPayload(source:string,destination:string):Promise<WindowsPayloadProfile>;

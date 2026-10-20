export interface WindowsPageManifest {packageVersion:string;aresVersion:string;rendererName:string;navigationRendererName:string;htmlSha256:string;rendererSha256:string;navigationHtmlSha256:string;navigationRendererSha256:string}
export interface WindowsRuntimeManifest {schemaVersion:1;executable:string;executableVersion:string;executableSha256:string;asarSha256:string;chromiumMajor:number;bundledPage:WindowsPageManifest}
export const WINDOWS_EXECUTABLE:string;
export const WINDOWS_MANIFEST_PATH:string;
export interface WindowsInstallationPaths {root:string;resources:string;executable:string;helperDirectory:string;helper:string;manifest:string;asar:string;dist:string}
export function windowsInstallationFromExecutable(executable:string):WindowsInstallationPaths;
export function windowsInstallationFromHelper(helper:string):WindowsInstallationPaths;
export const IM_CONTRACT:readonly string[];
export const NAVIGATION_CONTRACT:readonly string[];
export function supportedWindowsVersion(value:unknown):value is string;
export function compareWindowsAres(left:string,right:string):number;
export function validateWindowsPage(value:unknown):WindowsPageManifest;
export function validateWindowsRuntimeManifest(value:unknown,expectedExecutable?:string):WindowsRuntimeManifest;
export function windowsRendererName(html:string,kind:'imWindow'|'mainWindow'):string;
export function assertWindowsRendererContract(im:string,nav:string):void;

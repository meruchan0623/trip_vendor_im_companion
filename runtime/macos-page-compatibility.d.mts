export interface MacPageManifest {packageVersion:string;aresVersion:string;rendererName:string;navigationRendererName:string;htmlSha256:string;rendererSha256:string;navigationHtmlSha256:string;navigationRendererSha256:string}
export type MacPageBuild=Omit<MacPageManifest,'navigationRendererName'>&{documentURL:string;rendererURL:string;navigationURL:string;navigationRendererURL:string};
export interface MacRuntimeManifest {schemaVersion:1;executable:string;executableVersion:string;executableSha256:string;asarSha256:string;chromiumMajor:number;bundledPage:MacPageManifest}
export const MACOS_EXECUTABLE:string;
export const MACOS_MANIFEST_PATH:string;
export const MACOS_BUNDLED_DIST:string;
export const MACOS_PAGE_BUILDS:readonly Readonly<MacPageManifest>[];
export function macPageBuild(aresVersion:string,distURL:string):Readonly<MacPageBuild>;
export function validateMacPageBuild(value:unknown):Readonly<MacPageBuild>;
export function supportedMacVersion(value:unknown):value is string;
export function compareMacAres(left:string,right:string):number;
export function validateMacPage(value:unknown):MacPageManifest;
export function validateMacRuntimeManifest(value:unknown):MacRuntimeManifest;
export function macDynamicPageBuild(page:MacPageManifest,distURL:string):Readonly<MacPageBuild>;
export function macRendererName(html:string,kind:'imWindow'|'mainWindow'):string;
export function assertMacRendererContract(im:string,nav:string):void;

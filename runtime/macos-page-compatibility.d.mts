export interface MacPageManifest {packageVersion:string;aresVersion:string;rendererName:string;navigationRendererName:string;htmlSha256:string;rendererSha256:string;navigationHtmlSha256:string;navigationRendererSha256:string}
export type MacPageBuild=Omit<MacPageManifest,'navigationRendererName'>&{documentURL:string;rendererURL:string;navigationURL:string;navigationRendererURL:string};
export const MACOS_BUNDLED_DIST:string;
export const MACOS_PAGE_BUILDS:readonly Readonly<MacPageManifest>[];
export function macPageBuild(aresVersion:string,distURL:string):Readonly<MacPageBuild>;
export function validateMacPageBuild(value:unknown):Readonly<MacPageBuild>;

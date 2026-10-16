import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Reviewed vendor hot-update build. Never trust an arbitrary local dist or weaken runtime hashes.
export const MACOS_HOT_UPDATE = Object.freeze({
  aresVersion: '1.2.16',
  htmlSha256: '50b80642865961b0f20867c8059a6712eea763ad263e9a8cd82ff6bf56c6de0d',
  rendererSha256: 'af2a9fc0fb69daaf1848d42755587fe1374831e20ea87b3f7c4f53fc0814e405',
  rendererName: 'imWindow-Dd2iXeK_.js',
  navigationHtmlSha256: 'a668d0fed75b4fecc715fe2d3c3d1c1a8e47afeae70745ccd7ded4f953e82fd0',
  navigationRendererSha256: '457f1f2a1037fdcf13c17aa346a1189f761e11fcff680d5362821d5a218f7a7b',
});
export function hotUpdatePageBuild(dist) {
  const url = relative => pathToFileURL(join(dist, relative)).href;
  return {...MACOS_HOT_UPDATE, documentURL: url('src/pages/imPlus/index.html'),
    rendererURL: url('js/' + MACOS_HOT_UPDATE.rendererName),
    navigationURL: url('src/pages/main/index.html'), navigationRendererURL: url('js/mainWindow-BJrZBQ0Z.js')};
}
export function validatePageBuild(value) {
  if (!value || typeof value.documentURL !== 'string') throw new Error('INVALID_MACOS_PAGE_BUILD');
  const document = new URL(value.documentURL), suffix = '/src/pages/imPlus/index.html';
  if (document.protocol !== 'file:' || document.host || document.search || document.hash || !decodeURIComponent(document.pathname).endsWith('/Library/Application Support/vbk-electron/dist' + suffix)) throw new Error('INVALID_MACOS_PAGE_BUILD');
  const expected = hotUpdatePageBuild(decodeURIComponent(document.pathname).slice(0, -suffix.length));
  if (Object.keys(value).length !== Object.keys(expected).length || Object.keys(expected).some(key => value[key] !== expected[key])) throw new Error('INVALID_MACOS_PAGE_BUILD');
  return value;
}
export async function inspectMacPageBuild(home) {
  const dist = join(home, 'Library/Application Support/vbk-electron/dist');
  let version;
  try { version = JSON.parse(await readFile(join(dist, 'packageVersion.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (version.pkgVersion === '1.2.12' && version.aresVersion === '1.2.15') return undefined;
  if (version.pkgVersion !== '1.2.12' || version.aresVersion !== MACOS_HOT_UPDATE.aresVersion) throw new Error('UNSUPPORTED_MACOS_HOT_UPDATE');
  const page = hotUpdatePageBuild(dist);
  for (const [relative, key] of [['src/pages/imPlus/index.html','htmlSha256'], ['js/' + page.rendererName,'rendererSha256'], ['src/pages/main/index.html','navigationHtmlSha256'], ['js/mainWindow-BJrZBQ0Z.js','navigationRendererSha256']]) {
    const hash = createHash('sha256').update(await readFile(join(dist, relative))).digest('hex');
    if (hash !== page[key]) throw new Error('UNSUPPORTED_MACOS_HOT_UPDATE_HASH ' + relative);
  }
  return validatePageBuild(page);
}

import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {readAsar, asarFile, sha256} from './mac-pkg-asar.mjs';

/** Catch accidental all-files packaging before the helper reaches the client bundle. */
export async function verifyPackedMacHelper(helper){
  const contents=join(helper,'Contents'),archivePath=join(contents,'Resources/app.asar');
  const archiveBytes=(await stat(archivePath)).size;
  if(archiveBytes>64*1024*1024)throw new Error('HELPER_ARCHIVE_TOO_LARGE');
  const archive=await readFile(archivePath),{header}=readAsar(archive);
  const expected=['dist','dist-electron','licenses','package.json'];
  if(Object.keys(header.files).sort().join('|')!==expected.sort().join('|'))throw new Error('UNEXPECTED_HELPER_ARCHIVE_CONTENTS');
  for(const path of ['dist-electron/main.cjs','dist-electron/preload.cjs','dist/index.html']){
    if(sha256(asarFile(archive,path))!==sha256(await readFile(path)))throw new Error('STALE_HELPER_RESOURCE '+path);
  }
  const locales=(await readdir(join(contents,'Frameworks/Electron Framework.framework/Versions/A/Resources'))).filter(name=>name.endsWith('.lproj')).sort();
  if(locales.join('|')!==['en.lproj','en_GB.lproj','zh_CN.lproj','zh_TW.lproj'].join('|'))throw new Error('UNEXPECTED_HELPER_LOCALES');
  return{archiveBytes,locales};
}

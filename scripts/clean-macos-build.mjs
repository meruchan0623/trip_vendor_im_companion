#!/usr/bin/env node
import {rm, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';

// Explicit generated outputs only. Preserve source, dependencies, official inputs,
// installed applications, recovery backups, and acceptance evidence.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
for(const relative of ['release','dist','dist-electron','dist-runtime','dist-embedded','dist-lightweight','host/dist','native/macos/bin','native/windows/bin','native/windows/obj','native/resident/bin','native/resident/obj','native/browser-bridge/bin','native/browser-bridge/obj','node_modules/.vite','node_modules/.vite-temp','node_modules/.vitest-cache','work/patch-tests','work/mac-pkg-build','work/mac-inject','work/mac-migration','work/mac-arm64/electron-arm64-verified.zip']){
  const path=resolve(root,relative);
  console.log(`Remove generated build output: ${path}`);
  await rm(path,{recursive:true,force:true});
}

// Also remove stray PKG files anywhere in the workspace, without following symlinks.
async function removePackages(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.name.toLowerCase().endsWith('.pkg')) {
      console.log(`Remove PKG output: ${path}`);
      await rm(path, {recursive: true, force: true});
    } else if (entry.isDirectory()) await removePackages(path);
  }
}
await removePackages(root);

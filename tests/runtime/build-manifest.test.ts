import{describe,it,expect}from'vitest';
import{WINDOWS_RUNTIME_BUILD,MACOS_RUNTIME_BUILD,RUNTIME_PLATFORM,VERIFIED_RUNTIME_BUILD}from'../../runtime/build-manifest';
import{sameExecutablePath,assertBuildFingerprint,type BuildFingerprint}from'../../runtime/identity';
const BUNDLE='/Applications/旅游商家桌面版.app/',DIST=BUNDLE+'Contents/Resources/app.asar.unpacked/dist/';
const path=(url:string)=>{const parsed=new URL(url);expect(parsed.protocol).toBe('file:');expect(parsed.host).toBe('');expect(parsed.search+parsed.hash).toBe('');return decodeURIComponent(parsed.pathname);};
describe('per-platform vendor build manifests',()=>{
  it('describe the same fields so every consumer reads either build',()=>{expect(Object.keys(MACOS_RUNTIME_BUILD).sort()).toEqual(Object.keys(WINDOWS_RUNTIME_BUILD).sort());expect(Object.isFrozen(MACOS_RUNTIME_BUILD)&&Object.isFrozen(WINDOWS_RUNTIME_BUILD)).toBe(true);for(const key of ['executableSha256','asarSha256','htmlSha256','rendererSha256','navigationHtmlSha256','navigationRendererSha256']as const)expect(MACOS_RUNTIME_BUILD[key]).toMatch(/^[0-9a-f]{64}$/);});
  it('points every macOS URL at the unpacked dist inside the verified bundle',()=>{
    const build=MACOS_RUNTIME_BUILD;expect(build.executable).toBe(BUNDLE+'Contents/MacOS/旅游商家桌面版');expect(build.executable.normalize('NFC')).toBe(build.executable);
    expect(path(build.documentURL)).toBe(DIST+'src/pages/imPlus/index.html');expect(path(build.rendererURL)).toBe(DIST+'js/'+build.rendererName);expect(path(build.navigationURL)).toBe(DIST+'src/pages/main/index.html');expect(path(build.navigationRendererURL)).toBe(DIST+'js/mainWindow-2v9P5wjR.js');
  });
  it('keeps the Windows manifest selected under the test define',()=>{expect(RUNTIME_PLATFORM).toBe('win32');expect(VERIFIED_RUNTIME_BUILD).toBe(WINDOWS_RUNTIME_BUILD);expect(VERIFIED_RUNTIME_BUILD.executable).toBe('C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe');});
  it('compares Windows executables case-insensitively and refuses the macOS image there',()=>{
    expect(sameExecutablePath('c:\\program files\\VBK-ELECTRON\\.\\旅游商家桌面版.exe',WINDOWS_RUNTIME_BUILD.executable)).toBe(true);expect(sameExecutablePath('C:\\Program Files\\vbk-electron\\other.exe',WINDOWS_RUNTIME_BUILD.executable)).toBe(false);
    const fingerprint:BuildFingerprint={executable:MACOS_RUNTIME_BUILD.executable,executableVersion:MACOS_RUNTIME_BUILD.executableVersion,packageVersion:MACOS_RUNTIME_BUILD.packageVersion,aresVersion:MACOS_RUNTIME_BUILD.aresVersion,executableSha256:MACOS_RUNTIME_BUILD.executableSha256,asarSha256:MACOS_RUNTIME_BUILD.asarSha256,htmlSha256:MACOS_RUNTIME_BUILD.htmlSha256,rendererSha256:MACOS_RUNTIME_BUILD.rendererSha256};
    expect(()=>assertBuildFingerprint(fingerprint)).toThrow('UNVERIFIED_BUILD');
  });
});

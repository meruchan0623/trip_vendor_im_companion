/** Embedded by build-runtime; launcher and factory bytes ship as one reviewed artifact. */
declare const __RUNTIME_ARTIFACT_SOURCE__:string;
declare const __RUNTIME_ARTIFACT_SHA256__:string;
export const runtimeBundle=typeof __RUNTIME_ARTIFACT_SOURCE__==='undefined'?'':__RUNTIME_ARTIFACT_SOURCE__;
export const runtimeBundleSha256=typeof __RUNTIME_ARTIFACT_SHA256__==='undefined'?'':__RUNTIME_ARTIFACT_SHA256__;
declare const __NATIVE_ARTIFACT_SOURCE__:string;
declare const __NATIVE_ARTIFACT_SHA256__:string;
export const nativeBundle=typeof __NATIVE_ARTIFACT_SOURCE__==='undefined'?'':__NATIVE_ARTIFACT_SOURCE__;
export const nativeBundleSha256=typeof __NATIVE_ARTIFACT_SHA256__==='undefined'?'':__NATIVE_ARTIFACT_SHA256__;

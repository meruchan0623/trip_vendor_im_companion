import { defineConfig } from 'vitest/config';
// Pin the Windows manifest so the suite is host independent; macOS tests mock runtime/build-manifest.
export default defineConfig({ define:{__TMC_RUNTIME_PLATFORM__:'"win32"'}, test: { include:['tests/**/*.test.{ts,mjs}','src/ui/**/*.test.tsx','src/embedded/**/*.test.{ts,tsx}','host/**/*.test.ts'], exclude:['work/**','node_modules/**','release/**'] } });

import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include:['tests/**/*.test.{ts,mjs}','src/ui/**/*.test.tsx','src/embedded/**/*.test.{ts,tsx}','host/**/*.test.ts'], exclude:['work/**','node_modules/**','release/**'] } });

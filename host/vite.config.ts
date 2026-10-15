import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ build: { outDir: 'dist-host', lib: { entry: fileURLToPath(new URL('./runtime.ts', import.meta.url)), formats: ['es'], fileName: 'desktop-host' }, emptyOutDir: true } });

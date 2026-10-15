import { build } from 'esbuild';
await build({entryPoints:['src/embedded/index.tsx'],outfile:'dist-embedded/companion.js',bundle:true,platform:'browser',target:'chrome118',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});

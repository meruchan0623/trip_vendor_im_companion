#!/usr/bin/env node
/** Exact public native dependencies for vendor Electron 27.3.11, without editing project dependencies. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuild } from '@electron/rebuild';
const output = resolve(process.argv[2] || 'work/mac-arm64/native-build');
if (existsSync(output)) throw new Error(`Output exists: ${output}`);
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'package.json'), JSON.stringify({
  name: 'vendor-arm64-native-build', private: true, version: '1.0.0',
  dependencies: {
    'better-sqlite3': '11.1.2', sqlite3: '5.1.7', heapdump: '0.3.15', 'node-screenshots': '0.2.8',
    '@img/sharp-darwin-arm64': '0.34.5', '@img/sharp-libvips-darwin-arm64': '1.2.4',
    '@napi-rs/nice-darwin-arm64': '1.1.1', '@napi-rs/snappy-darwin-arm64': '7.3.3',
  },
}, null, 2) + '\n');
const args = ['install', '--prefix', output, '--ignore-scripts', '--registry=https://registry.npmjs.org', '--fetch-timeout=30000', '--fetch-retries=0'];
console.log('npm', ...args);
const installed = spawnSync('npm', args, { stdio: 'inherit' });
if (installed.status !== 0) process.exit(installed.status || 1);
console.log('Rebuild better-sqlite3, sqlite3, heapdump for Electron 27.3.11 arm64');
await rebuild({ buildPath: output, electronVersion: '27.3.11', arch: 'arm64', force: true, onlyModules: ['better-sqlite3', 'sqlite3', 'heapdump'] });
console.log(`Native modules ready: ${resolve(output, 'node_modules')}`);

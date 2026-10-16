import {afterEach, describe, expect, it} from 'vitest';
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// @ts-expect-error Direct Node installer module.
import {installInjectedMacApp} from '../scripts/lib/mac-inject-transaction.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mac-inject-')); roots.push(root);
  const source = join(root, 'built.app'), target = join(root, 'installed.app');
  await mkdir(source); await mkdir(target);
  await writeFile(join(source, 'version'), 'new'); await writeFile(join(target, 'version'), 'old');
  const copy = (from: string, to: string) => cp(from, to, {recursive: true});
  const verify = async (app: string) => { expect(await readFile(join(app, 'version'), 'utf8')).toBe('new'); };
  return {root, source, target, copy, verify};
}
describe('direct macOS injection replacement', () => {
  it('verifies the same-volume stage before swapping and preserves the complete prior app', async () => {
    const f = await fixture(); const checks: string[] = [];
    const result = await installInjectedMacApp({...f, verify: async (app: string) => { checks.push(app); await f.verify(app); }});
    expect(checks[0]).toContain(join(f.root, '.trip-vendor-inject-'));
    expect(checks[1]).toBe(f.target);
    expect(await readFile(join(result.backup, 'version'), 'utf8')).toBe('old');
    expect(await readFile(join(f.target, 'version'), 'utf8')).toBe('new');
  });
  for (const failure of ['copy', 'stage verification', 'first rename', 'second rename', 'installed verification']) {
    it(`restores the old app after ${failure} failure`, async () => {
      const f = await fixture(); let moves = 0;
      await expect(installInjectedMacApp({...f,
        copy: async (from: string, to: string) => { await f.copy(from, to); if (failure === 'copy') throw new Error('injected'); },
        verify: async (app: string) => { if (failure === 'stage verification' || (failure === 'installed verification' && app === f.target)) throw new Error('injected'); await f.verify(app); },
        move: async (from: string, to: string) => { moves++; if ((failure === 'first rename' && moves === 1) || (failure === 'second rename' && moves === 2)) throw new Error('injected'); await rename(from, to); }
      })).rejects.toThrow('injected');
      expect(await readFile(join(f.target, 'version'), 'utf8')).toBe('old');
      expect((await readdir(f.root)).filter(name => name.startsWith('.trip-vendor-inject'))).toEqual([]);
    });
  }
  it('retains the backup and reports its location when recovery itself fails', async () => {
    const f = await fixture(); let moves = 0;
    await expect(installInjectedMacApp({...f, move: async (from: string, to: string) => { if (++moves >= 2) throw new Error('rename failure'); await rename(from, to); }})).rejects.toThrow('INSTALL_RECOVERY_REQUIRED');
    const transaction = (await readdir(f.root)).find(name => name.startsWith('.trip-vendor-inject-'))!;
    expect(await readFile(join(f.root, transaction, 'previous.app/version'), 'utf8')).toBe('old');
  });
  it('installs an absent app without retaining an empty backup directory', async () => {
    const f = await fixture(); await rm(f.target, {recursive: true});
    const result = await installInjectedMacApp(f);
    expect(result.backup).toBeNull(); await f.verify(f.target);
    expect((await readdir(f.root)).filter(name => name.startsWith('.trip-vendor-inject'))).toEqual([]);
  });
  it('leaves an unrelated legacy backup intact', async () => {
    const f = await fixture(), legacy = join(f.root, 'legacy-pkg-state');
    await mkdir(legacy); await writeFile(join(legacy, 'original'), 'original');
    await installInjectedMacApp(f);
    expect(await readFile(join(legacy, 'original'), 'utf8')).toBe('original');
  });
});

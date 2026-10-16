const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const vendorRequire = createRequire(resolve(process.argv[2], 'package.json'));
async function main() {
  const result = { arch: process.arch, electron: process.versions.electron, abi: process.versions.modules, checks: [] };
  for (const name of ['better-sqlite3', 'sqlite3', 'heapdump', 'sharp', 'node-screenshots', '@napi-rs/nice', 'snappy']) {
    try {
      const value = vendorRequire(name);
      if (name === 'better-sqlite3') {
        const db = new value(':memory:');
        assert.equal(db.prepare('select 2 + 3 as answer').get().answer, 5);
        db.close();
      }
      if (name === 'sqlite3') await new Promise((ok, fail) => {
        const db = new value.Database(':memory:');
        db.get('select 2 + 3 as answer', (error, row) => {
          if (error) return db.close(() => fail(error));
          try { assert.equal(row.answer, 5); } catch (failure) { return db.close(() => fail(failure)); }
          db.close(error => error ? fail(error) : ok());
        });
      });
      if (name === 'sharp') assert.equal((await value({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()).subarray(1, 4).toString(), 'PNG');
      if (name === 'snappy') assert.equal(value.uncompressSync(value.compressSync(Buffer.from('native smoke'))).toString(), 'native smoke');
      result.checks.push({ name, passed: true });
    } catch (error) { result.checks.push({ name, passed: false, error: error.message }); }
  }
  result.privateTelemetry = [];
  for (const name of ['@ctrip/node-vampire-cache', '@ctrip/node-vampire-locker', '@ctrip/ares-agent']) {
    try { vendorRequire(name); result.privateTelemetry.push({ name, loaded: true }); }
    catch (error) { result.privateTelemetry.push({ name, loaded: false, error: error.message }); }
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.checks.some(check => !check.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });

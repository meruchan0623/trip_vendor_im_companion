// macOS-only integration fixture. Builds and runs the repository launcher with
// synthetic child scripts and redirects fixture logs into a temporary directory.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {launcherSource} from '../scripts/install-macos-companion.mjs';

if(process.platform!=='darwin'){
  console.log('SKIP macOS launcher integration requires macOS; no installed client was examined.');
}else{
  const directory=await mkdtemp(join(tmpdir(),'tsim-launcher-recovery-'));
  const run=(file,args,env)=>new Promise((resolve,reject)=>{
    const child=spawn(file,args,{stdio:'inherit',env:env??process.env});
    // Signal only the process handle created by this fixture. The launcher
    // forwards cancellation to its own vendor Process; no process scans/kills.
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},60000);timer.unref();
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);code===0&&!timedOut?resolve():reject(Error(`fixture child failed code=${code} signal=${signal} timedOut=${timedOut}`));});
  });
  try{
    // Only test logging is redirected. All process launch/recovery code remains
    // the exported source used by every real packaging path.
    const original='let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/trip_vendor_im_companion")';
    assert.equal(launcherSource.split(original).length,2);
    const source=launcherSource.replace(original,'let logs = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TSIM_RECOVERY_TEST_LOGS"]!)');
    const swift=join(directory,'main.swift'),binary=join(directory,'launcher');await writeFile(swift,source);
    await run('/usr/bin/xcrun',['swiftc','-o',binary,swift]);
    const scenarios=[
      {name:'bounded-crash-recovery',vendorSeconds:19,helper:'sleep 0.7\nexit 72',starts:4,recoveries:3},
      {name:'normal-exit-stays-closed',vendorSeconds:2.5,helper:'sleep 0.7\nexit 0',starts:1,recoveries:0},
      {name:'owner-exit-cancels-backoff',vendorSeconds:1.1,helper:'sleep 0.7\nexit 72',starts:1,recoveries:0},
      {name:'initial-lock-release-retries',vendorSeconds:3,helper:'count=$(/usr/bin/wc -l < "$TSIM_RECOVERY_TEST_STARTS")\nif [ "$count" -lt 3 ]; then exit 0; fi\nsleep 0.7\nexit 0',starts:3,recoveries:0},
    ];
    for(const scenario of scenarios){
      const root=join(directory,scenario.name),contents=join(root,'Fixture.app','Contents'),macos=join(contents,'MacOS');
      const companion=join(contents,'Resources','companion'),helperDirectory=join(companion,'旅游商家助手.app','Contents','MacOS');
      const logs=join(root,'logs'),starts=join(root,'starts');
      await mkdir(macos,{recursive:true});await mkdir(helperDirectory,{recursive:true});
      const launcher=join(macos,'TripVendorLauncher'),vendor=join(macos,'SyntheticVendor'),helper=join(helperDirectory,'SyntheticHelper');
      await copyFile(binary,launcher);await chmod(launcher,0o755);
      await writeFile(join(companion,'launcher.json'),JSON.stringify({vendorExecutable:'SyntheticVendor',companionExecutable:'SyntheticHelper'}));
      await writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>tech.tsim.recovery.fixture.${randomUUID()}</string></dict></plist>`);
      await writeFile(vendor,`#!/bin/sh\nexec /bin/sleep ${scenario.vendorSeconds}\n`);await chmod(vendor,0o755);
      // mkdir is atomic, so overlap of two running helpers produces exit 91.
      await writeFile(helper,`#!/bin/sh\nif ! /bin/mkdir "$TSIM_RECOVERY_TEST_LOCK"; then echo overlap >> "$TSIM_RECOVERY_TEST_STARTS"; exit 91; fi\ntrap '/bin/rmdir "$TSIM_RECOVERY_TEST_LOCK"' EXIT\n/bin/date +%s >> "$TSIM_RECOVERY_TEST_STARTS"\n${scenario.helper}\n`);await chmod(helper,0o755);
      await run(launcher,[],{...process.env,TSIM_RECOVERY_TEST_LOGS:logs,TSIM_RECOVERY_TEST_STARTS:starts,TSIM_RECOVERY_TEST_LOCK:join(root,'helper-active')});
      const lines=(await readFile(starts,'utf8')).trim().split('\n');assert.equal(lines.includes('overlap'),false,scenario.name);
      assert.equal(lines.length,scenario.starts,scenario.name);
      const intervals=lines.slice(1).map((line,i)=>Number(line)-Number(lines[i]));
      if(scenario.recoveries===3)for(const [i,delay] of [1,3,10].entries()){
        assert.ok(intervals[i]>=delay&&intervals[i]<=delay+3,`backoff ${delay}s + child runtime; measured integer-second interval ${intervals[i]}s`);
      }
      const log=await readFile(join(logs,'launcher.log'),'utf8');
      assert.equal((log.match(/companion-recovery-start attempt=/g)??[]).length,scenario.recoveries,scenario.name);
      console.log(`PASS ${scenario.name}: starts=${lines.length} recoveries=${scenario.recoveries} intervals_seconds=${JSON.stringify(intervals)}`);
    }
    console.log('macos_launcher_recovery_ok: synthetic children only; no installed app/window/account access');
  }finally{
    // Fake helpers live at most 0.7s; after owner cancellation they can finish
    // naturally before fixture removal, without touching unrelated processes.
    await new Promise(resolve=>setTimeout(resolve,1000));
    await rm(directory,{recursive:true,force:true});
  }
}

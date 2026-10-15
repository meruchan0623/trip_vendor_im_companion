import {readFile,writeFile} from 'node:fs/promises';
const paths=process.argv.slice(2);if(!paths.length)throw new Error('SAMPLE_PATH_REQUIRED');
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;};
const reports=[];
for(const path of paths){
  const data=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),groups={};
  for(const group of ['helper','vendor']){
    let previous=0;
    const samples=data.samples.filter(s=>s.group===group).map(s=>{const duration=s.seconds-previous;previous=s.seconds;return {...s,duration};}).filter(s=>s.seconds>60);
    if(!samples.length)continue;
    const cpuValid=data.measurementVersion>=2;
    groups[group]={samples:samples.length,
      privateCommitMiB:{p50:percentile(samples.map(s=>s.privateCommitMiB),.5),p95:percentile(samples.map(s=>s.privateCommitMiB),.95),peak:Math.max(...samples.map(s=>s.privateCommitMiB))},
      workingSetMiB:{p50:percentile(samples.map(s=>s.workingSetMiB),.5),p95:percentile(samples.map(s=>s.workingSetMiB),.95)},
      cpuPercentMachine:cpuValid?{mean:samples.reduce((sum,s)=>sum+s.cpuPercentMachine*s.duration,0)/samples.reduce((sum,s)=>sum+s.duration,0),p95:percentile(samples.map(s=>s.cpuPercentMachine),.95)}:{valid:false,reason:'Legacy PowerShell integer overload rounded CPU deltas; do not use'},
      processCountPeak:Math.max(...samples.map(s=>s.processes))};
  }
  reports.push({path,measurementVersion:data.measurementVersion??1,elapsedSeconds:data.elapsedSeconds,excludedWarmupSeconds:60,groups,limitations:data.limitations});
}
console.log(JSON.stringify(reports,null,2));
await writeFile('work/lightweight-acceptance/resource-summary.json',JSON.stringify(reports,null,2));

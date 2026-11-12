'use strict';
// Persistent backup queue. Connects projects through the browser and verifies repositories with GitHub CLI.
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const ROOT=__dirname;
const OWNER=process.env.GITHUB_OWNER;
if(!OWNER||!process.env.ORCA_WORKTREE) throw new Error('Set GITHUB_OWNER and ORCA_WORKTREE before running.');
const ORCA=process.env.ORCA_CLI_PATH || 'orca';
const GH=process.env.GH_CLI_PATH || 'gh';
const TASK='Lovable GitHub Backups Until Complete';
const WORKSPACE=process.env.ORCA_WORKTREE;
const STATE=path.join(ROOT,'automation-state.json');
const MANIFEST=path.join(ROOT,'inventory.json');
const LOCK=path.join(ROOT,'automation.lock');
const COOLDOWN=65*60*1000;
const RETRY=20*60*1000;
const now=()=>new Date().toISOString();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
function atomic(file,data) {
 const tmp=file+'.tmp';
 fs.writeFileSync(tmp,data);
 fs.renameSync(tmp,file);
}
const writeJson=(file,data)=>atomic(file,JSON.stringify(data,null,2)+'\n');
function log(event,detail={}) {
 const line=JSON.stringify({at:now(),event,...detail});
 fs.appendFileSync(path.join(ROOT,'automation-progress.jsonl'),line+'\n');
 console.log(line);
}
function clean(message) {
 return String(message).replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,'[REDACTED]').slice(0,1200);
}
async function run(file,args,options={}) {
 try {
  const r=await exec(file,args,{windowsHide:true,timeout:70000,maxBuffer:8*1024*1024,...options,
    env:{...process.env,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0',...(options.env??{})}});
  return r.stdout;
 } catch(error) {throw new Error(clean(error.stderr||error.stdout||error.message));}
}
async function orca(args) {
 const response=JSON.parse(await run(ORCA,[...args,'--json']));
 if(!response.ok)throw new Error(clean(JSON.stringify(response.error)));
 return response.result;
}
async function github(endpoint) {
 return JSON.parse(await run(GH,['api',endpoint,'-H','Accept: application/vnd.github+json']));
}
function saveManifest(manifest) {
 manifest.updated_at=now();
 writeJson(MANIFEST,manifest);
 const keys=['id','name','editor_url','latest_commit_sha','repository','github_commit_sha','backup_status','repository_visibility'];
 const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
 atomic(path.join(ROOT,'inventory.csv'),keys.join(',')+'\n'+manifest.projects.map(p=>keys.map(k=>quote(p[k])).join(',')).join('\n')+'\n');
}
function summary(manifest,state) {
 const saved=manifest.projects.filter(p=>p.backup_status==='current_commit_verified');
 const pending=manifest.projects.length-saved.length;
 state.verified=saved.length;state.total=manifest.projects.length;state.remaining=pending;state.updated_at=now();
 writeJson(STATE,state);
 const lines=[
 '# Lovable GitHub backups','',
 'Workspace backup status. GitHub owner: '+OWNER+'.','',
 'Verified: '+saved.length+' of '+manifest.projects.length+'. Remaining: '+pending+'.','',
 '## Automatic queue','',
 '- Status: '+state.phase,
 '- Next eligible attempt (UTC): '+(state.next_attempt_at??'none'),
 '- Windows task: '+TASK,
 '- Local trigger checks every 10 minutes and on sign-in. It makes no Lovable requests during cooldown.',
 '- Up to 10 projects per batch, with paced connections. Wait at least 65 minutes after each batch or rate-limit response.',
 '- No Codex/AI calls are needed for scheduled batches.',
 '- Tasks do not overlap. The task disables itself only after every project passes verification.',
 '- Keep Windows signed in, Orca open, and Lovable signed in. Sleep/offline/login problems defer work and remain in the status log.',
 '',
 '## Verified private repositories','',
 '| Project | GitHub |','| --- | --- |',
 ...saved.map(p=>'| '+(p.name??p.repository.split('/')[1])+' | ['+p.repository+'](https://github.com/'+p.repository+') |'),
 '',
 '## Pull a project','',
 '~~~powershell',
 'git clone https://github.com/'+OWNER+'/your-repository.git',
 'git -C your-repository pull --ff-only',
 '~~~','',
 'inventory.json and inventory.csv map all project IDs, repositories and verified commits. automation-state.json records cooldown and completion. automation-progress.jsonl records each scheduled run. connection-progress.jsonl records individual connections.',
 '',
 'Verification for scheduled exports requires: private GitHub visibility; the original Lovable source commit equals or is an ancestor of the GitHub branch head; and Lovable UI reports In sync with GitHub. The verification_method field distinguishes this from earlier direct MCP commit comparisons. A final GitHub audit is required before automatic completion.',
 '',
 'GitHub backups cover source code and repository assets. Database records, uploaded cloud storage and server secrets require separate backups. Git sync is two-way.',
 '',
 'The earlier Orca agent automation was disabled after hitting its Codex usage limit. This Windows task replaces it.',
 '',
 'Documentation: https://docs.lovable.dev/integrations/github',''
 ];
 atomic(path.join(ROOT,'BACKUP_STATUS.md'),lines.join('\n'));
}
async function verifyOne(project) {
 const [repoOwner,repoName]=(project.repository??'').split('/');
 if(repoOwner!==OWNER||! /^[A-Za-z0-9_.-]+$/.test(repoName??''))throw new Error('Unexpected repository for '+project.id);
 const baseline=project.original_commit_sha??project.latest_commit_sha;
 if(!/^[a-f0-9]{40}$/i.test(baseline??''))throw new Error('Missing original commit for '+project.id);
 const meta=await github('repos/'+project.repository);
 if(meta.private!==true)throw new Error('Repository must be private: '+project.repository);
 const branch=meta.default_branch;
 if(!branch)throw new Error('Missing default branch: '+project.repository);
 const head=await github('repos/'+project.repository+'/commits/'+encodeURIComponent(branch));
 if(!/^[a-f0-9]{40}$/i.test(head.sha??''))throw new Error('Missing GitHub commit: '+project.repository);
 if(head.sha!==baseline) {
  const compare=await github('repos/'+project.repository+'/compare/'+baseline+'...'+head.sha);
  if(!['ahead','identical'].includes(compare.status)||compare.behind_by!==0||compare.merge_base_commit?.sha!==baseline) {
   throw new Error('Original source commit is not preserved in the default branch: '+project.repository);
  }
 }
 project.original_commit_sha=baseline;
 project.github_commit_sha=head.sha;
 project.latest_commit_sha=head.sha;
 project.repository_visibility='private';
 project.verified_at=now();
 project.verification_method=project.verification_method??'github_private_original_commit_ancestor_and_lovable_ui_sync';
 project.verified_source_commit_sha=baseline;
 project.source_history_preserved=true;
 project.backup_status='current_commit_verified';
 delete project.backup_error;
 log('repository_verified',{id:project.id,repository:project.repository,sha:head.sha});
}
async function verifyPending(manifest) {
 let failed=0;
 for(const p of manifest.projects.filter(p=>p.backup_status==='ui_sync_confirmed_api_pending')) {
  try {await verifyOne(p);}
  catch(error) {p.backup_status='verification_needs_review';p.backup_error=clean(error.message);failed++;log('verification_failed',{id:p.id,error:p.backup_error});}
  saveManifest(manifest);
 }
 return failed;
}
async function finalAudit(manifest) {
 log('final_audit_start',{projects:manifest.projects.length});
 const repos=manifest.projects.map(p=>p.repository);
 if(new Set(repos).size!==manifest.projects.length)throw new Error('Final audit found multiple projects using one repository; manual review is needed.');
 for(const p of manifest.projects) {
  try {await verifyOne(p);}
  catch(error) {p.backup_status='verification_needs_review';p.backup_error=clean(error.message);saveManifest(manifest);throw error;}
 }
 manifest.final_audit_at=now();
 saveManifest(manifest);
}
async function disableTask() {
 try {
  await run('C:\\Windows\\System32\\schtasks.exe',['/Change','/TN',TASK,'/DISABLE']);
  log('schedule_disabled');
 } catch(error) {log('schedule_disable_failed',{error:clean(error.message)});}
}
function acquireLock() {
 try {fs.writeFileSync(LOCK,JSON.stringify({pid:process.pid,started_at:now()}),{flag:'wx'});return true;}
 catch(error) {
  if(error.code!=='EEXIST')throw error;
  const old=read(LOCK);
  try {process.kill(old.pid,0);log('overlap_skipped',{pid:old.pid});return false;}
  catch(check) {if(check.code!=='ESRCH'){log('overlap_unverifiable',{pid:old.pid});return false;}}
  fs.unlinkSync(LOCK);
  fs.writeFileSync(LOCK,JSON.stringify({pid:process.pid,started_at:now()}),{flag:'wx'});
  return true;
 }
}
async function main() {
 const state=read(STATE);
 let manifest=read(MANIFEST);
 if(process.argv.includes('--health-check')||state.health_check_due) {
  const login=(await run(GH,['api','user','--jq','.login'])).trim();
  if(login!==OWNER)throw new Error('Expected configured GitHub account.');
  const tabs=await orca(['tab','list','--worktree',WORKSPACE]);
  const probe=structuredClone(manifest.projects.find(p=>p.backup_status==='current_commit_verified'));
  await verifyOne(probe);
  log('health_check_passed',{github:login,browser_tabs:tabs.tabs.length,verified:manifest.projects.filter(p=>p.backup_status==='current_commit_verified').length,next_attempt_at:state.next_attempt_at});
  if(state.health_check_due) {state.health_check_due=false;state.last_health_check_at=now();saveManifest(manifest);summary(manifest,state);}
  return;
 }
 if(state.phase==='complete') {await disableTask();log('already_complete');return;}
 if(state.next_attempt_at&&Date.now()<Date.parse(state.next_attempt_at)) {
  log('cooldown_skipped',{next_attempt_at:state.next_attempt_at});return;
 }
 if(!acquireLock())return;
 state.last_run_at=now();state.phase='checking';writeJson(STATE,state);
 try {
  const login=(await run(GH,['api','user','--jq','.login'])).trim();
  if(login!==OWNER)throw new Error('GitHub account does not match GITHUB_OWNER.');
  await verifyPending(manifest);
  if(manifest.projects.every(p=>p.backup_status==='current_commit_verified')) {
   await finalAudit(manifest);
   manifest.status='complete';state.phase='complete';state.next_attempt_at=null;state.completed_at=now();
   saveManifest(manifest);summary(manifest,state);await disableTask();log('all_projects_complete',{projects:manifest.projects.length});return;
  }
  const pending=manifest.projects.filter(p=>!['current_commit_verified','ui_sync_confirmed_api_pending','verification_needs_review'].includes(p.backup_status));
  if(!pending.length)throw new Error('Remaining projects need verification review; details are in inventory.json.');
  const tabs=await orca(['tab','list','--worktree',WORKSPACE]);
  let tab=tabs.tabs.find(t=>t.browserPageId===state.browser_page_id&&new URL(t.url).hostname==='lovable.dev');
  tab??=tabs.tabs.find(t=>t.url.startsWith('https://lovable.dev/')&&t.worktreeId===WORKSPACE);
  if(!tab) {
   const created=await orca(['tab','create','--worktree',WORKSPACE,'--url',pending[0].editor_url]);
   tab={browserPageId:created.browserPageId};
  }
  state.browser_page_id=tab.browserPageId;
  state.phase='running';state.batch_started_at=now();writeJson(STATE,state);
  const beforeVerified=manifest.projects.filter(p=>p.backup_status==='current_commit_verified').length;
  const batchSize=Math.min(state.batch_size??10,pending.length);
  log('batch_start',{pending:pending.length,limit:batchSize,page:tab.browserPageId});
  await run(process.execPath,[path.join(ROOT,'connect-projects.cjs'),String(batchSize)],{
   timeout:25*60*1000,env:{LOVABLE_BACKUP_PAGE_ID:tab.browserPageId}
  });
  manifest=read(MANIFEST);
  const failures=await verifyPending(manifest);
  const logLines=fs.readFileSync(path.join(ROOT,'connection-progress.jsonl'),'utf8').trim().split(/\r?\n/).slice(-100);
  const batchEvents=logLines.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(e=>e&&Date.parse(e.at)>=Date.parse(state.batch_started_at));
  const lastFailure=batchEvents.filter(e=>e.event==='error').at(-1);
  const rateLimited=logLines.some(line=>{try{const e=JSON.parse(line);return Date.parse(e.at)>=Date.parse(state.batch_started_at)&&/rate_limit_exceeded|Rate limit exceeded/.test(e.error??'');}catch{return false;}});
  const verified=manifest.projects.filter(p=>p.backup_status==='current_commit_verified').length;
  if(verified===manifest.projects.length) {
   await finalAudit(manifest);
   manifest.status='complete';state.phase='complete';state.next_attempt_at=null;state.completed_at=now();
   saveManifest(manifest);summary(manifest,state);await disableTask();log('all_projects_complete',{projects:verified});return;
  }
  const stalled=!rateLimited&&verified===beforeVerified&&lastFailure;
  state.phase=rateLimited?'cooldown_rate_limit':stalled?'retry_pending':failures?'verification_needs_attention':'cooldown';
  state.next_attempt_at=new Date(Date.now()+(stalled?RETRY:COOLDOWN)).toISOString();
  state.last_batch_finished_at=now();state.last_error=lastFailure?clean(lastFailure.error):null;
  manifest.status=state.phase;
  saveManifest(manifest);summary(manifest,state);
  log('batch_finished',{verified,remaining:manifest.projects.length-verified,rate_limited:rateLimited,next_attempt_at:state.next_attempt_at});
 } catch(error) {
  state.phase='retry_pending';state.last_error=clean(error.message);
  state.next_attempt_at=new Date(Date.now()+RETRY).toISOString();
  manifest=read(MANIFEST);manifest.status=state.phase;saveManifest(manifest);summary(manifest,state);
  log('run_deferred',{error:state.last_error,next_attempt_at:state.next_attempt_at});
 } finally {
  if(fs.existsSync(LOCK)&&read(LOCK).pid===process.pid)fs.unlinkSync(LOCK);
 }
}
main().catch(error=>{log('fatal',{error:clean(error.message)});process.exitCode=1;});

// Connect Lovable projects to GitHub through observed UI controls only.
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const root = __dirname;
const manifestPath = path.join(root, 'inventory.json');
const browserPageId = process.env.LOVABLE_BACKUP_PAGE_ID;
const OWNER=process.env.GITHUB_OWNER;
const ACCOUNT_LABEL=process.env.LOVABLE_GITHUB_ACCOUNT_LABEL;
if(!browserPageId||!OWNER||!ACCOUNT_LABEL) throw new Error('Set LOVABLE_BACKUP_PAGE_ID, GITHUB_OWNER, and LOVABLE_GITHUB_ACCOUNT_LABEL.');
const orca = process.env.ORCA_CLI_PATH || 'orca';
const limit = Number(process.argv[2] || 100);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const log = entry => {
  const line = JSON.stringify({at:new Date().toISOString(), ...entry});
  fs.appendFileSync(path.join(root,'connection-progress.jsonl'),line+'\n');
  console.log(line);
};
function save() {
  manifest.status='in_progress';
  manifest.updated_at=new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest,null,2)+'\n');
  const keys=['id','name','editor_url','latest_commit_sha','repository','github_commit_sha','backup_status','repository_visibility'];
  const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  fs.writeFileSync(path.join(root,'inventory.csv'),keys.join(',')+'\n'+manifest.projects.map(p=>keys.map(k=>quote(p[k])).join(',')).join('\n')+'\n');
}
async function cli(args) {
  let stdout;
  try { ({stdout}=await exec(orca,[...args,'--json'],{timeout:65000,maxBuffer:4*1024*1024,windowsHide:true})); }
  catch(error) {
    if(error.stdout) {
      try {const response=JSON.parse(error.stdout);throw new Error(JSON.stringify(response.error??response));}
      catch(parsed) {if(!(parsed instanceof SyntaxError)) throw parsed;}
    }
    throw error;
  }
  const response=JSON.parse(stdout);
  if(!response.ok)throw new Error(JSON.stringify(response.error));
  return response.result;
}
async function snapshot() {return cli(['snapshot','--page',browserPageId,'--interactive']);}
async function pageText() {return (await cli(['eval','--page',browserPageId,'--expression','document.body.innerText.slice(-6000)'])).result;}
async function connected(p) {
 const url=p.editor_url+'?view=more&subview=settings-git&git_provider=github';
 await cli(['goto','--page',browserPageId,'--url',url]);
 await cli(['wait','--page',browserPageId,'--fn',"/(Connect project|Repository connection)/.test(document.body.innerText) && document.body.innerText.includes('GitHub')",'--timeout','25000']);
 let state=await snapshot();
 if(state.url!==url)throw new Error('Unexpected project URL '+state.url);
 const refs=Object.entries(state.refs??{});
 const repoField=refs.find(([key,ref])=>ref.role==='textbox'&&ref.name==='HTTPS URL');
 if(!repoField) {
   if(!refs.some(([key,ref])=>ref.role==='rowheader'&&ref.name===`${OWNER} ${ACCOUNT_LABEL}`)) {
     throw new Error('Expected GitHub account was not found. '+state.snapshot.slice(-2500));
   }
   const connect=refs.filter(([key,ref])=>ref.role==='button'&&ref.name==='Connect');
   if(connect.length!==1)throw new Error('Expected exactly one Connect button.');
   p.backup_status='connecting';
   p.original_commit_sha??=p.latest_commit_sha;
   save();
   log({event:'connect_requested',id:p.id,name:p.name});
   await cli(['click','--page',browserPageId,'--expect-url',url,'--element','@'+connect[0][0]]);
   await cli(['wait','--page',browserPageId,'--fn',"/(Repository connection|Rate limit exceeded|Failed to sync project)/.test(document.body.innerText)",'--timeout','45000']);
   const afterConnect=await pageText();
   if(/Rate limit exceeded/i.test(afterConnect)) throw new Error('rate_limit_exceeded: Lovable rejected the connection; stop and let the cooldown reset.');
   if(/Failed to sync project/i.test(afterConnect)&&!afterConnect.includes('Repository connection')) throw new Error('Lovable failed to sync this project.');
   state=await snapshot();
 }
 const urls=[...(state.snapshot.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git/g)??[])].filter(url=>url.startsWith(`https://github.com/${OWNER}/`));
 const unique=[...new Set(urls)];
 if(unique.length!==1)throw new Error(`Expected one ${OWNER} clone URL. `+state.snapshot.slice(-3000));
 p.repository=unique[0].replace('https://github.com/','').replace(/\.git$/,'');
 p.backup_status='repository_connected_sync_pending';
 p.connected_at=new Date().toISOString();
 p.repository_visibility=p.repository_visibility??'pending_api_verification';
 save();
 let text=await pageText();
 if(!text.includes('In sync with GitHub')) {
    try {await cli(['wait','--page',browserPageId,'--text','In sync with GitHub','--timeout','45000']);}
    catch(error) {log({event:'sync_wait_pending',id:p.id,repository:p.repository,error:error.message});}
    text=await pageText();
 }
 p.backup_status=text.includes('In sync with GitHub')?'ui_sync_confirmed_api_pending':'repository_connected_sync_pending';
 p.ui_sync_checked_at=new Date().toISOString();
 delete p.backup_error;
 save();
 log({event:'connected',id:p.id,name:p.name,repository:p.repository,status:p.backup_status});
}
(async()=>{
 const pending=manifest.projects.filter(p=>p.backup_status!=='current_commit_verified'&&p.backup_status!=='ui_sync_confirmed_api_pending'&&p.backup_status!=='verification_needs_review');
 log({event:'start',pending:pending.length,limit});
 let completed=0,failures=0;
 for(const p of pending.slice(0,limit)){
   try {await connected(p);completed++;failures=0;if(completed<Math.min(limit,pending.length))await new Promise(resolve=>setTimeout(resolve,30000));}
   catch(error) {
      p.backup_error=error.message;p.backup_status='setup_needs_review';save();
      log({event:'error',id:p.id,name:p.name,error:error.message});
      if(/rate_limit_exceeded/.test(error.message)||++failures>=2){log({event:'stopped_for_review_or_cooldown'});break;}
   }
 }
 log({event:'run_finished',completed,statuses:manifest.projects.reduce((a,p)=>(a[p.backup_status]=(a[p.backup_status]??0)+1,a),{})});
})().catch(error=>{log({event:'fatal',error:error.stack});process.exitCode=1;});

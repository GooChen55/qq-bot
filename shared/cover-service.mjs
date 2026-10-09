import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {cacheKey,validateSettings} from './cover-core.mjs';
import {separateSong,separationModels,separationKey,verifiedLegacyWeights} from './cover-separation.mjs';
import {CoverQueue,digest,fingerprints,fileStamp} from './cover-cache.mjs';
import {projectPath,executable} from '../deployment/paths.mjs';
import {coverModel,coverModels,importCoverModel} from './cover-models.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=process.env.COVER_DATA_DIR?path.resolve(process.env.COVER_DATA_DIR):projectPath('shared/cover-data');
const port=Number(process.env.COVER_PORT)||9882;
const run=promisify(execFile);
const ff=executable('ffmpeg','COVER_FFMPEG','runtimes/GPT-SoVITS-v3lora-20250228/ffmpeg.exe');
const probe=executable('ffprobe','COVER_FFPROBE','runtimes/GPT-SoVITS-v3lora-20250228/ffprobe.exe');
const python=executable('python3','COVER_PYTHON','runtimes/Applio/.venv/Scripts/python.exe');
const coverRuntime=process.env.COVER_RUNTIME_DIR||path.join(root,'runtimes/Applio');
for(const d of ['songs','outputs','logs'])fs.mkdirSync(path.join(data,d),{recursive:true});
const lock=path.join(data,'service.lock');
try{const previous=Number(fs.readFileSync(lock,'utf8'));if(Number.isInteger(previous)&&previous>0){let alive=false;try{process.kill(previous,0);alive=true;}catch{}if(alive)throw Error('Cover service already running');}fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
process.on('exit',()=>{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}});
const read=(f,fallback)=>{try{return JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));}catch{return fallback;}};
const store=(f,v)=>{const t=f+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(t,JSON.stringify(v,null,2));fs.renameSync(t,f);};
const tokenFile=path.join(data,'control-token');
if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('hex'));
const token=fs.readFileSync(tokenFile,'utf8').trim();
const configFile=path.join(data,'config.json'),songsFile=path.join(data,'songs.json'),jobsFile=path.join(data,'jobs.json');
const fleet=()=>read(projectPath('bots.json'),{fleet:[]}).fleet;
const defaultConfig={bots:Object.fromEntries(fleet().map(b=>[b.id,{enabled:false,modelId:'',pitch:0,deliveryMode:'preview_file'}])),publicAllowed:false,maxSeconds:900};
let config=read(configFile,defaultConfig),songs=read(songsFile,[]),jobs=read(jobsFile,[]);
store(configFile,config);
for(const j of jobs)if(['queued','running'].includes(j.status)){j.status='interrupted';j.error='服务重启；请重新提交，不会自动重复发送';}
const persist=()=>store(jobsFile,jobs.slice(-100));persist();
let worker=null,workerReady=null,waiter=null,idle=null,backendError='';
let closing=false;
process.on('exit',()=>{try{worker?.kill();}catch{}});
const log=fs.createWriteStream(path.join(data,'logs/worker.log'),{flags:'a'});
async function startWorker(){
 clearTimeout(idle);if(worker)return workerReady;
 workerReady=new Promise((resolve,reject)=>{
  const p=spawn(python,[path.join(root,'shared/cover-worker.py')],{cwd:coverRuntime,windowsHide:true,env:{...process.env,COVER_RUNTIME_DIR:coverRuntime,PYTHONIOENCODING:'utf-8'}});worker=p;
  const timer=setTimeout(()=>{reject(Error('翻唱模型启动超时'));p.kill();},180000);
  p.stderr.pipe(log,{end:false});
  const failed=err=>{clearTimeout(timer);backendError=String(err.message);reject(err);waiter?.reject(err);waiter=null;if(worker===p)worker=null;};
  p.on('error',failed);p.on('exit',code=>{if(worker===p)failed(Error('翻唱进程退出 '+code));});
  readline.createInterface({input:p.stdout}).on('line',line=>{try{
   const v=JSON.parse(line);if(v.ready){clearTimeout(timer);backendError='';resolve();}
   if(waiter&&v.id===waiter.id){const w=waiter;waiter=null;v.ok?w.resolve():w.reject(Error(v.error));}
  }catch{log.write(line+'\n');}});
 });return workerReady;
}
async function infer(j){
 await startWorker();await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{worker?.kill();reject(Error('翻唱任务超时'));},30*60*1000);
  waiter={id:j.id,resolve:()=>{clearTimeout(timer);resolve();},reject:e=>{clearTimeout(timer);reject(e);}};
  worker.stdin.write(JSON.stringify(j)+'\n');
 });
 idle=setTimeout(()=>{if(!queue.active)void releaseWorker();},60000);
}
async function releaseWorker(){
 clearTimeout(idle);const p=worker;if(!p)return;
 worker=null;workerReady=null;
 await new Promise(resolve=>{const timer=setTimeout(resolve,10000);p.once('exit',()=>{clearTimeout(timer);resolve();});p.kill();});
}
const fingerprintFile=path.join(data,'fingerprints.json');
const sha=fingerprints(read(fingerprintFile,{}),v=>store(fingerprintFile,v));
const durationMemo=new Map();
function model(id){return id?coverModel(data,id):coverModels(data)[0]||null;}
async function duration(f){const stamp=fileStamp(f);if(durationMemo.get(f)?.stamp===stamp)return durationMemo.get(f).value;const {stdout}=await run(probe,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',f],{windowsHide:true});const d=Number(stdout.trim());if(!Number.isFinite(d)||d<=0)throw Error('无法读取音频时长');durationMemo.set(f,{stamp,value:d});return d;}
async function snapshot(s,m,pitch,limit=Number(config.maxSeconds)||900){
 const seconds=Math.min(900,limit,await duration(s.mix||s.vocal));
 const files=[s.mix||s.vocal,s.backing,m.pth,m.index].filter(Boolean);
 const sep=s.mix?separationModels[s.separationModel||'fast']:null;
 const sepFile=sep&&path.join(data,'separation-models',sep);
 if(sepFile&&fs.existsSync(sepFile))files.push(sepFile);
 const stamps=Object.fromEntries(files.map(f=>[f,fileStamp(f)]));
 const hashes=await Promise.all(files.map(sha));
 for(const [f,stamp] of Object.entries(stamps))if(fileStamp(f)!==stamp)throw Error('素材或模型发生变化，请重新提交');
 const recipe={v:3,hashes,pitch,seconds,sep,separatorRecipe:1,rvcRecipe:2};
 return {song:structuredClone(s),model:structuredClone(m),pitch,seconds,stamps,key:digest(recipe)};
}
const artifactFile=path.join(data,'artifacts.json');
const validArtifact=a=>[a.output,a.clip].every(f=>f&&/^[a-f0-9]{64}(?:-qq)?\.mp3$/.test(f)&&fs.existsSync(path.join(data,'outputs',f))&&fs.statSync(path.join(data,'outputs',f)).size>128);
const notifications=new Set();
const queue=new CoverQueue({artifacts:read(artifactFile,{}),valid:validArtifact,save:v=>store(artifactFile,v),changed:()=>{persist();for(const notify of notifications)notify();},compute:async(snap,progress)=>{
   if(read(path.join(data,'cuda-install.json'),{}).stage==='installing')throw Error('GPU 环境正在安装，请稍后重试');
   for(const [f,stamp] of Object.entries(snap.stamps))if(fileStamp(f)!==stamp)throw Error('排队期间素材或权重发生变化，请重新提交');
   const begin=Date.now(),timings={};
   let s=snap.song;const m=snap.model,seconds=snap.seconds;
   s=await separateSong({root,data,python,song:s,seconds,sha,run,ff,releaseWorker,progress});
   timings.separationMs=Date.now()-begin;
   progress('转换目标音色');
   const conversionStart=Date.now();
   const key=cacheKey({v:2,input:await sha(s.vocal),backing:s.backing?await sha(s.backing):'',model:await sha(m.pth),index:m.index?await sha(m.index):'',pitch:snap.pitch,seconds});
   const output=path.join(data,'outputs',key+'.mp3'),clip=path.join(data,'outputs',key+'-qq.mp3');
   if(!fs.existsSync(output)){
    const input=path.join(data,'outputs',key+'-input.wav'),converted=path.join(data,'outputs',key+'-vocal.wav');
    await run(ff,['-y','-v','error','-i',s.vocal,'-t',String(seconds),'-ac','1','-ar','48000',input],{windowsHide:true});
    await infer({id:crypto.randomUUID(),input,output:converted,model:m.pth,index:m.index,pitch:snap.pitch});
    timings.conversionMs=Date.now()-conversionStart;progress('混合伴奏与编码');
    // Bundled FFmpeg 4.3 does not support amix normalize=0. Its default
    // divides by two, compensated after mixing; preserve relative levels.
    const args=s.backing?['-i',converted,'-i',s.backing,'-filter_complex','[0:a]aformat=channel_layouts=stereo,volume=1.0[v];[1:a]aformat=channel_layouts=stereo,volume=0.65[b];[v][b]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95']:['-i',converted];
    await run(ff,['-y','-v','error',...args,'-codec:a','libmp3lame','-b:a','192k',output+'.partial.mp3'],{windowsHide:true});
    fs.renameSync(output+'.partial.mp3',output);
   }
   if(!fs.existsSync(clip))await run(ff,['-y','-v','error','-i',output,'-t','45','-codec:a','libmp3lame','-b:a','128k',clip],{windowsHide:true});
   timings.totalMs=Date.now()-begin;timings.encodingMs=timings.totalMs-timings.separationMs-(timings.conversionMs||0);
   for(const [f,stamp] of Object.entries(snap.stamps))if(fileStamp(f)!==stamp)throw Error('生成期间素材或权重被修改，请重新提交');
   const result={output:path.basename(output),clip:path.basename(clip),durationSeconds:await duration(output),separationCached:s.separationCached,timings};
   // The first model download adds its weight fingerprint. Register that alias
   // too, so the very next request does not regenerate the same complete song.
   const refreshed=await snapshot(snap.song,snap.model,snap.pitch,snap.seconds);
   if(refreshed.key!==snap.key)queue.artifacts[refreshed.key]=result;
   return result;
}});
async function adoptLegacy(snap){
 if(queue.artifacts[snap.key]&&validArtifact(queue.artifacts[snap.key]))return;
 if(snap.song.mix){const name=separationModels[snap.song.separationModel||'fast'],weight=path.join(data,'separation-models',name);if(!fs.existsSync(weight)||await sha(weight)!==verifiedLegacyWeights[name])return;}
 // Reuse earlier whole-song products only after deriving their old content key.
 for(const cap of [...new Set(jobs.filter(j=>j.songId===snap.song.id&&j.status==='completed'&&j.pitch===snap.pitch&&Math.min(j.maxSeconds||180,snap.seconds)===snap.seconds).map(j=>j.maxSeconds||180))]){
  let s=snap.song;
  if(s.mix){const key=separationKey(await sha(s.mix),separationModels[s.separationModel||'fast'],cap);const dir=path.join(data,'separation-cache',key);if(!fs.existsSync(path.join(dir,'complete.json')))continue;s={...s,vocal:path.join(dir,'vocal.wav'),backing:path.join(dir,'backing.wav')};}
  if(!s.vocal||![s.vocal,s.backing].filter(Boolean).every(f=>fs.existsSync(f)))continue;
  const key=cacheKey({v:2,input:await sha(s.vocal),backing:s.backing?await sha(s.backing):'',model:await sha(snap.model.pth),index:snap.model.index?await sha(snap.model.index):'',pitch:snap.pitch,seconds:cap});
  const artifact={output:key+'.mp3',clip:key+'-qq.mp3',separationCached:!!s.mix};
  if(validArtifact(artifact)){artifact.durationSeconds=await duration(path.join(data,'outputs',artifact.output));queue.artifacts[snap.key]=artifact;store(artifactFile,queue.artifacts);return;}
 }
}
function waitJob(id,req,res){
 return new Promise(resolve=>{
  const finish=value=>{clearTimeout(timer);notifications.delete(check);res.off('close',closed);resolve(value);};
  const check=()=>{const j=jobs.find(j=>j.id===id);if(!j||!['queued','running'].includes(j.status))finish(j?publicJob(j):{error:'任务记录不存在'});};
  const closed=()=>finish(null);
  const timer=setTimeout(()=>{const j=jobs.find(j=>j.id===id);finish(j?publicJob(j):{error:'任务记录不存在'});},25000);
  notifications.add(check);res.once('close',closed);check();
 });
}
async function body(req){let s='';for await(const b of req){s+=b;if(s.length>1024*1024)throw Error('请求过大');}return JSON.parse(s||'{}');}
const publicJob=j=>({...j,outputUrl:j.output?'http://127.0.0.1:'+port+'/audio/'+j.output:undefined});
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&/^\/audio\/[a-f0-9]{64}(?:-qq)?\.mp3$/.test(u.pathname)){
   const f=path.join(data,'outputs',path.basename(u.pathname));if(!fs.existsSync(f)){res.writeHead(404);return res.end();}
   res.setHeader('Content-Type','audio/mpeg');return fs.createReadStream(f).pipe(res);
  }
  if(req.headers.authorization!=='Bearer '+token&&u.searchParams.get('token')!==token){res.writeHead(401);return res.end('Access token required');}
  if(req.method==='GET'&&u.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(fs.readFileSync(path.join(root,'shared/cover-panel.html')));}
  let result;
  if(req.method==='GET'&&u.pathname==='/api/status')result={config,songs,jobs:jobs.map(publicJob),model:model(),models:coverModels(data),backend:{workerRunning:!!worker,error:backendError,environmentExists:fs.existsSync(python)},queue:{computeTasks:queue.tasks.size,artifacts:Object.keys(queue.artifacts).length},separation:{models:separationModels,backend:read(path.join(data,'separator-backend.json'),null),installed:fs.existsSync(path.join(root,'runtimes/Applio/.venv/Lib/site-packages/audio_separator'))},fleet:fleet().map(b=>({id:b.id,label:b.label}))};
  else if(req.method==='GET'&&u.pathname==='/api/job'){
   const id=u.searchParams.get('id');if(!jobs.some(j=>j.id===id))throw Error('任务记录不存在');
   result=u.searchParams.get('wait')==='1'?await waitJob(id,req,res):publicJob(jobs.find(j=>j.id===id));if(!result)return;
  }
  else if(req.method==='POST'&&u.pathname==='/api/config'){const b=await body(req),next=validateSettings(b,fleet().map(b=>b.id));for(const v of Object.values(next.bots))if(v.enabled&&!model(v.modelId))throw Error('请先导入并选择自己的翻唱模型');config=next;store(configFile,config);if(b.modelRightsConfirmed!==undefined)for(const id of new Set(Object.values(config.bots).filter(v=>v.enabled).map(v=>v.modelId))){const m=model(id);if(m){m.rightsConfirmed=b.modelRightsConfirmed===true;store(path.join(data,'models',id,'model.json'),m);}}result={ok:true};}
  else if(req.method==='POST'&&u.pathname==='/api/models/import')result={ok:true,model:importCoverModel(data,await body(req))};
  else if(req.method==='POST'&&u.pathname==='/api/import'){
   const b=await body(req);if(!/^[a-zA-Z0-9_-]{1,60}$/.test(b.id)||!String(b.title||'').trim())throw Error('歌曲 ID 仅允许英文、数字、横线和下划线');
   if(songs.some(s=>s.id===b.id))throw Error('ID 已存在，请换一个，不会覆盖素材');
   const full=b.inputMode==='mix';
   if(full&&!b.mix)throw Error('请选择包含人声和伴奏的完整歌曲');
   if(full&& !Object.hasOwn(separationModels,b.separationModel||'fast'))throw Error('分离模式无效');
   if(!full&&!b.vocal)throw Error('需要主唱音频；只有伴奏不能翻唱');
   const dest=path.join(data,'songs',b.id);const imported={id:b.id,title:String(b.title).slice(0,100),rightsConfirmed:b.rightsConfirmed===true,source:String(b.source||'用户本地导入').slice(0,300)};
   const sources=full?[['mix',b.mix]]:[['vocal',b.vocal],['backing',b.backing]];
   // Validate every source before creating or copying anything.
   for(const [,source] of sources)if(source){
    if(!path.isAbsolute(source)||!fs.statSync(source).isFile()||fs.statSync(source).size>200*1024*1024)throw Error('素材必须为本地音频文件，最大 200 MB');
    if(!/\.(mp3|wav|flac|m4a|ogg)$/i.test(source))throw Error('不支持的音频扩展名');
    const d=await duration(source);if(d>900)throw Error('请先将素材剪至 15 分钟以内');
   }
   for(const [key,source] of sources)if(source){
    fs.mkdirSync(dest,{recursive:true});const f=path.join(dest,key+path.extname(source).toLowerCase());fs.copyFileSync(source,f);imported[key]=f;
   }
   imported.durationSeconds=await duration(imported.mix||imported.vocal);
   imported.fingerprints=Object.fromEntries(await Promise.all([imported.mix,imported.vocal,imported.backing].filter(Boolean).map(async f=>[path.basename(f),await sha(f)])));
   if(full)imported.separationModel=b.separationModel||'fast';
   songs.push(imported);store(songsFile,songs);result={ok:true,song:imported};
  }else if(req.method==='POST'&&u.pathname==='/api/jobs'){
   if(closing)throw Error('服务正在重启，请稍后重试');
   const b=await body(req),s=songs.find(s=>s.id===b.songId),v=config.bots[b.botId],m=model(v?.modelId);
   const deliveryMode=b.deliveryMode||v?.deliveryMode||'preview_file';
   if(!['preview_file','full_voice'].includes(deliveryMode))throw Error('发送模式无效');
   if(!v?.enabled)throw Error('该机器人未开启翻唱');if(!s?.vocal&&!s?.mix)throw Error('歌曲不存在或没有音频素材');if(!m||v.modelId!==m.id)throw Error('模型未就绪');
   if(b.public===true&&(!config.publicAllowed||!s.rightsConfirmed||!m.rightsConfirmed))throw Error('公开发送未启用，或歌曲/模型授权未确认；可先在本地面板试听');
   const dup=b.requestKey&&jobs.find(j=>j.requestKey===String(b.requestKey));if(dup)result=publicJob(dup);
   else{
    const begin=Date.now(),snap=await snapshot(s,m,v.pitch);await adoptLegacy(snap);
    // Async fingerprinting may overlap another copy of the same message.
    const duplicate=b.requestKey&&jobs.find(j=>j.requestKey===String(b.requestKey));
    if(duplicate)result=publicJob(duplicate);
    else{
     const j={id:crypto.randomUUID(),songId:b.songId,botId:b.botId,pitch:v.pitch,deliveryMode,maxSeconds:snap.seconds,fileName:(s.title+'-'+b.botId+'.mp3').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,110),status:'queued',createdAt:new Date().toISOString(),requestKey:String(b.requestKey||'')};
     queue.submit(j,snap);j.lookupMs=Date.now()-begin;jobs.push(j);persist();result=publicJob(j);
    }
   }
  }else if(req.method==='POST'&&u.pathname==='/api/claim-delivery'){
   const b=await body(req),j=jobs.find(j=>j.id===b.id);if(!j||j.status!=='completed')throw Error('任务未完成');
   result={claimed:!j.deliveryClaimed};if(!j.deliveryClaimed){j.deliveryClaimed=true;persist();}
  }else if(req.method==='POST'&&u.pathname==='/api/cancel'){
   const b=await body(req),j=jobs.find(j=>j.id===b.id);if(!j)throw Error('任务不存在');queue.cancel(j);result={ok:true};
  }else if(req.method==='POST'&&u.pathname==='/api/shutdown'){
   if(queue.tasks.size)throw Error('仍有翻唱任务，请完成后再重启');closing=true;await releaseWorker();result={ok:true};
   setImmediate(()=>server.close(()=>process.exit(0)));
  }else{res.writeHead(404);return res.end('Not found');}
  res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:String(e.message)}));}
});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('Shared cover service listening on 127.0.0.1:'+port));

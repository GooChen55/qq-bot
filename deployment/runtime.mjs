import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {PROJECT_ROOT} from './paths.mjs';
import {BOT_IDS,PORTS,dataRoot,prepare,resolveProvider,atomic} from './config.mjs';
import {patchOfficialSDK} from './official-hooks.mjs';
const require=createRequire(import.meta.url);
export function dshEntry(){if(process.env.QQBOT_DSH_ENTRY)return path.resolve(process.env.QQBOT_DSH_ENTRY);return path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js');}
export const listening=port=>new Promise(resolve=>{const socket=net.connect({port,host:'127.0.0.1'});socket.setTimeout(600);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
export async function doctor(config){
 const checks=[];
 try{checks.push({item:'DSH',ok:fs.existsSync(dshEntry())});}catch{checks.push({item:'DSH',ok:false,detail:'先执行 npm install'});}
 for(const id of BOT_IDS.filter(id=>config.bots[id]?.enabled)){
  const b=config.bots[id],p=resolveProvider(config,id);
  checks.push({item:id+' AI key',ok:!!process.env[p.env],detail:'环境变量 '+p.env});
  for(const [label,port] of Object.entries(PORTS[id]))checks.push({item:id+' '+label+' port',ok:!await listening(port),detail:String(port)});
  if(Number(id.slice(3))<3)checks.push({item:id+' official credentials',ok:!!process.env[id.toUpperCase()+'_APP_ID']&&!!process.env[id.toUpperCase()+'_APP_SECRET']});
  else checks.push({item:id+' OneBot token',ok:!!process.env[b.onebot_token_env],detail:'环境变量 '+b.onebot_token_env});
 }
 return checks;
}
export class FleetRuntime {
 constructor(config){this.config=config;this.children=new Map();this.stopping=false;}
 env(id){const data=dataRoot(this.config);return {...process.env,QQBOT_ROOT:PROJECT_ROOT,QQBOT_BOT_ID:id,QQBOT_DATA_DIR:data,QQBOT_STATE_DIR:path.join(data,id,'state'),QQBOT_BOT_CONFIG:path.join(data,id,'config.json'),DSH_HOME:path.join(data,id,Number(id.slice(3))<3?'home':'dsh-home')};}
 launch(key,entry,args,env){
  if(this.children.has(key))throw Error(key+' 已在运行');
  const p=spawn(entry,args,{cwd:PROJECT_ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});this.children.set(key,p);
  const logDir=path.join(dataRoot(this.config),'logs');fs.mkdirSync(logDir,{recursive:true});
  const log=fs.createWriteStream(path.join(logDir,key+'.log'),{flags:'a',mode:0o600});let buffer='';
  const accept=bytes=>{buffer+=bytes;const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(let line of lines){
   const token=/[?&]token=([A-Za-z0-9_%.-]+)/.exec(line);if(token&&key.endsWith('-dsh'))atomic(path.join(env.QQBOT_STATE_DIR,'dsh-token'),decodeURIComponent(token[1]));
   line=line.replace(/([?&]token=)[^\s]+/g,'$1[redacted]');for(const [name,value] of Object.entries(env))if(/KEY|SECRET|TOKEN/.test(name)&&value)line=line.split(value).join('[redacted]');log.write(line+'\n');
  }};p.stdout.on('data',accept);p.stderr.on('data',accept);
  p.once('exit',()=>{this.children.delete(key);log.end();});p.once('error',e=>{this.children.delete(key);log.end('Process start failed: '+e.code+'\n');});return p;
 }
 async startBot(id){
  if(!BOT_IDS.includes(id)||!this.config.bots[id]?.enabled)throw Error('机器人未启用');
  if(this.children.has(id+'-dsh'))throw Error(id+' 已在运行');
  const partial={...this.config,bots:Object.fromEntries(Object.entries(this.config.bots).map(([key,b])=>[key,{...b,enabled:key===id}]))};
  const checks=await doctor(partial);if(checks.some(c=>!c.ok))throw Error('启动前检查失败：'+checks.filter(c=>!c.ok).map(c=>c.item).join('，'));
  prepare(this.config);const env=this.env(id),official=Number(id.slice(3))<3,profile=official?id==='bot1'?'qqbot':'qqbot2':'web';
  if(official){const dir=path.join(env.DSH_HOME,'profiles',profile);await promisify(execFile)(process.platform==='win32'?'npm.cmd':'npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:dir,windowsHide:true,shell:process.platform==='win32',maxBuffer:4*1024*1024});patchOfficialSDK(dir);}
  this.launch(id+'-dsh',process.execPath,[dshEntry(),'--profile',profile,'--patch',path.join(env.DSH_HOME,'ai.generated.patch.yml'),'--no-open','--host','127.0.0.1','--port',String(PORTS[id].dsh)],env);
  for(let n=0;n<120;n++){if(!this.children.has(id+'-dsh'))throw Error('DSH 启动失败，请查看数据目录 logs');if(await listening(PORTS[id].dsh))break;await new Promise(r=>setTimeout(r,500));}
   if(!await listening(PORTS[id].dsh)){await this.stopBot(id);throw Error('DSH 启动超时');}
  if(!official)this.launch(id+'-bridge',process.execPath,[path.join(PROJECT_ROOT,id,'src/bridge.js')],env);
 }
 async stopBot(id){for(const key of [id+'-bridge',id+'-dsh']){const p=this.children.get(key);if(!p)continue;await this.stopChild(p);}}
 async stopChild(p){
  if(p.exitCode!==null)return;
  if(process.platform==='win32')await promisify(execFile)('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
  else {p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(p.exitCode===null)p.kill('SIGKILL');}
  if(p.exitCode===null)await Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);
 }
 async stopServices(){for(const [key,p] of [...this.children])if(key.startsWith('service-'))await this.stopChild(p);}
 async startServices(){
  const env={...process.env,QQBOT_ROOT:PROJECT_ROOT,QQBOT_DATA_DIR:dataRoot(this.config)};
  const selected=[['activities','shared/activity-service.mjs',3011],['debate','debate/src/hub.js',Number(process.env.DEBATE_HUB_PORT)||3010],['cover','shared/cover-service.mjs',Number(process.env.COVER_PORT)||9882],['voice','shared/voice-service.mjs',9881]].filter(([key])=>this.config.services?.[key]||(key==='debate'&&this.config.services?.activities));
  for(const [key,,port] of selected)if(this.children.has('service-'+key)||await listening(port))throw Error(key+' 服务端口已占用：'+port+'；不接管旧进程');
  for(const [key,file] of selected)this.launch('service-'+key,process.execPath,[path.join(PROJECT_ROOT,file)],env);
 }
 async close(){this.stopping=true;for(const id of BOT_IDS)await this.stopBot(id);for(const p of [...this.children.values()])await this.stopChild(p);}
 status(){return [...this.children].map(([name,p])=>({name,pid:p.pid,running:p.exitCode===null}));}
}

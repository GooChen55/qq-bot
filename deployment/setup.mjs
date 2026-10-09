import fs from 'node:fs';
import path from 'node:path';
import {BOT_IDS,dataRoot,configFile,readJSON,jsonWrite,atomic} from './config.mjs';
const idPattern=/^[a-zA-Z0-9_-]{1,60}$/;
export function installPersona(config,{id,name,text,bots=[],overwrite=false}){
 if(!idPattern.test(String(id||''))||!String(text||'').trim()||String(text).length>64000)throw Error('请填写有效人格 ID 和正文（最多 64000 字）');
 if(!Array.isArray(bots)||bots.some(b=>!BOT_IDS.includes(b)||!config.bots[b]))throw Error('人格分配的机器人不存在');
 const dir=path.join(dataRoot(config),'persona/library'),file=path.join(dir,id+'.txt');
 if(fs.existsSync(file)&&!overwrite)throw Error('人格 ID 已存在；如需替换请明确勾选覆盖');
 let manifest;try{manifest=readJSON(path.join(dir,'manifest.json'));}catch{manifest={personas:[]};}
 if(!Array.isArray(manifest.personas))throw Error('人格库清单损坏，不覆盖现有数据');
 atomic(file,String(text).trim()+'\n');
 manifest.personas=manifest.personas.filter(p=>p.id!==id);manifest.personas.push({id,name:String(name||id).slice(0,100),file:id+'.txt'});jsonWrite(path.join(dir,'manifest.json'),manifest);
 const next=structuredClone(config);for(const b of bots)next.bots[b].persona=id;jsonWrite(configFile(),next);
 return next;
}
export async function voiceRequest(action,body,{fetchImpl=fetch}={}){
 const routes={projects:'/training/projects',profiles:'/profiles',create:'/training/create',prepare:'/training/prepare',train:'/training/train',cancel:'/training/cancel'};
 if(!routes[action])throw Error('未知语音设置操作');
 const base=(process.env.VOICE_SERVICE_URL||'http://127.0.0.1:9881').replace(/\/+$/,'');
 const r=await fetchImpl(base+routes[action],{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(action==='create'?120000:30000)});
 const result=await r.json();if(!r.ok||result.ok===false)throw Error(result.error||'语音服务请求失败');return result;
}
export async function assignVoice(config,{bot,profileId,replyMode='text'},{fetchImpl=fetch}={}){
 if(!BOT_IDS.includes(bot)||!config.bots[bot]||!['text','smart','always'].includes(replyMode))throw Error('机器人或语音模式无效');
 const {profiles}=await voiceRequest('profiles',undefined,{fetchImpl});if(!profiles?.some(p=>p.id===profileId))throw Error('音色尚未训练发布或登记');
 const base=(process.env.VOICE_SERVICE_URL||'http://127.0.0.1:9881').replace(/\/+$/,'');
 const file=path.join(dataRoot(config),'shared/voice-fleet.json'),fleet=readJSON(file);
 fleet.bots??={};fleet.bots[bot]={...fleet.bots[bot],enabled:true,profileId,replyMode};fleet.serviceUrl=base;
 const next=structuredClone(config),b=next.bots[bot];
 b.bridge??={};b.bridge.socialV2??={};b.bridge.socialV2.voice={...b.bridge.socialV2.voice,enabled:true,provider:'gpt-sovits',serviceUrl:base,defaultProfileId:profileId,replyMode};
 jsonWrite(configFile(),next);jsonWrite(file,fleet);return next;
}

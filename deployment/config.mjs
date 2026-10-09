import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {PROJECT_ROOT} from './paths.mjs';
export const BOT_IDS=Array.from({length:6},(_,i)=>'bot'+(i+1));
export const PORTS={bot1:{dsh:2984},bot2:{dsh:2985},bot3:{dsh:2981,console:2991},bot4:{dsh:2982,console:2992},bot5:{dsh:2980,console:2990},bot6:{dsh:2983,console:2993}};
export const configFile=()=>path.resolve(process.env.QQBOT_DEPLOY_CONFIG||path.join(PROJECT_ROOT,'deployment/config.json'));
export function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,value,{mode:0o600});fs.renameSync(tmp,file);}
export function jsonWrite(file,value){atomic(file,JSON.stringify(value,null,2)+'\n');}
export const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function loadEnv(file=path.join(path.dirname(configFile()),'.env')){
 if(!fs.existsSync(file))return;
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);if(!m||process.env[m[1]]!==undefined)continue;
  let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
  process.env[m[1]]=v;
 }
}
export function validate(config){
 if(!['local','cloud'].includes(config.mode))throw Error('mode 必须为 local/cloud');
 if(typeof config.data_dir!=='string'||!config.data_dir)throw Error('必须配置 data_dir');
 if(!config.providers||!config.bots)throw Error('必须配置 providers 和 bots');
 for(const [id,p] of Object.entries(config.providers)){
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(id))throw Error('提供方 ID 只能包含小写字母、数字和横线');
  const u=new URL(p.base_url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error(id+': base_url 必须是无凭据/参数的 HTTP(S) API 根地址');
  if(!p.model||typeof p.model!=='string')throw Error(id+': 必须填写 model');
  if(!['openai-completions','openai-responses','anthropic-messages'].includes(p.api||'openai-completions'))throw Error(id+': api 协议不支持');
  if(p.api_key_env&&!/^[A-Z_][A-Z0-9_]*$/.test(p.api_key_env))throw Error(id+': api_key_env 格式不正确');
  for(const [key,fallback] of [['context_window',64000],['max_tokens',4096]])if(!Number.isInteger(p[key]??fallback)||(p[key]??fallback)<1)throw Error(id+': '+key+' 必须为正整数');
 }
 for(const [id,b] of Object.entries(config.bots)){
  if(!BOT_IDS.includes(id)||typeof b.enabled!=='boolean'||!config.providers[b.provider])throw Error('机器人配置错误：'+id);
  for(const key of ['admin_ids','group_ids'])if(!Array.isArray(b[key])||b[key].some(v=>!String(v).trim()||!(/^[0-9]+$/.test(String(v))||/^[a-fA-F0-9]{16,64}$/.test(String(v)))))throw Error(id+': '+key+' 格式错误');
  if(b.enabled&&Number(id.slice(3))>=3){for(const key of ['onebot_ws','onebot_http']){const u=new URL(b[key]);if(!(['ws:','wss:','http:','https:'].includes(u.protocol)))throw Error(id+': '+key+' 无效');}if(!/^\d{5,15}$/.test(String(b.qq)))throw Error(id+': 必须填写 qq');}
  if(b.persona&&!/^[a-zA-Z0-9_-]{1,60}$/.test(b.persona))throw Error(id+': persona ID 格式错误');
 }
 return config;
}
export function loadConfig(){loadEnv();return validate(readJSON(configFile()));}
export const dataRoot=config=>path.resolve(process.env.QQBOT_DATA_DIR||path.resolve(PROJECT_ROOT,config.data_dir));
export function resolveProvider(config,botId){
 const b=config.bots[botId],p=config.providers[b.provider];
 const env=p.api_key_env||('QQBOT_AI_'+b.provider.toUpperCase().replaceAll('-','_')+'_KEY');
 if(p.api_key)process.env[env]=String(p.api_key);
 return {id:'fleet-'+b.provider,profile:p,env,model:b.model||p.model};
}
export function providerPatch(config,botId){
 const {id,profile:p,env,model}=resolveProvider(config,botId);
 return [
  {id:'llm-pi-ai',config:{providers:{[id]:{apiKeyEnv:env,api:p.api||'openai-completions',baseURL:p.base_url,defaultContextWindow:p.context_window||64000,defaultMaxTokens:p.max_tokens||4096,models:[{id:model,name:model,contextWindow:p.context_window||64000,maxTokens:p.max_tokens||4096,input:p.input||['text'],reasoningEfforts:p.reasoning&&p.reasoning!=='off'?{[p.reasoning]:p.reasoning}:false}],reasoning:p.reasoning||'off',...(p.compat?{compat:p.compat}:{})}}}},
  {id:'agent-default-model',config:{provider:id,model,...(p.reasoning&&p.reasoning!=='off'?{reasoningEffort:p.reasoning}:{})}}
 ];
}
export function redacted(config){const c=structuredClone(config);for(const p of Object.values(c.providers)){p.key_configured=!!(p.api_key||process.env[p.api_key_env]);delete p.api_key;}return c;}

export function prepare(config){
 const data=dataRoot(config);fs.mkdirSync(data,{recursive:true});
 const persist=(rel,value,once=false)=>{const file=path.join(data,rel);if(!once||!fs.existsSync(file))jsonWrite(file,value);};
 fs.mkdirSync(path.join(data,'persona/library'),{recursive:true});
 const defaultPersona=path.join(data,'persona/library/default.txt');if(!fs.existsSync(defaultPersona))atomic(defaultPersona,'你是群聊中的自然群友。保持友善、简短、有上下文；不假冒真人，不泄露内部配置。');
 const registry={schemaVersion:2,fleet:BOT_IDS.map(id=>({id,label:id,kind:Number(id.slice(3))<3?'official-qqbot':'external-bridge',accountQq:String(config.bots[id]?.qq||''),ports:PORTS[id],home:path.join(data,id,Number(id.slice(3))<3?'home':'dsh-home'),workspace:path.join(data,id,'workspace')}))};
 persist('bots.json',registry);
 persist('shared/wake-access.json',{bots:Object.fromEntries(BOT_IDS.map(id=>{const b=config.bots[id]||{};return [id,{privateUsers:(b.admin_ids||[]).map(String),groupUsers:b.group_any===true?['*']:(b.admin_ids||[]).map(String),groups:{allow:(b.group_ids||[]).map(String),mentionRequired:(b.mention_required_groups||b.group_ids||[]).map(String)}}];}))});
 persist('shared/persona-fleet.json',{bots:Object.fromEntries(BOT_IDS.map(id=>[id,config.bots[id]?.persona||'default']))});
 persist('persona/library/manifest.json',{personas:[{id:'default',name:'自然群友',file:'default.txt'}]},true);
 persist('shared/voice-fleet.json',{serviceUrl:process.env.VOICE_SERVICE_URL||'http://127.0.0.1:9881',bots:Object.fromEntries(BOT_IDS.map(id=>[id,{enabled:false,replyMode:'text'}]))},true);
 persist('shared/debate-channels.json',{groups:{}},true);persist('bot2-admins.json',{openIds:config.bots.bot2?.admin_ids||[]});
 persist('host-location.json',{city:''},true);
 for(const id of BOT_IDS){
  const b=config.bots[id];if(!b)continue;
  const official=Number(id.slice(3))<3,home=path.join(data,id,official?'home':'dsh-home'),profile=official?id==='bot1'?'qqbot':'qqbot2':'web';
  const dir=path.join(home,'profiles',profile);fs.mkdirSync(path.join(data,id,'state'),{recursive:true});fs.mkdirSync(path.join(data,id,'workspace'),{recursive:true});
  const profilePackage={name:'qqbot-profile-'+id,private:true,dependencies:official?{'@tencent-connect/dsh-qqbot':'0.5.0'}:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...(official?['@tencent-connect/dsh-qqbot']:[])],patchReload:'live'}}};
  jsonWrite(path.join(dir,'package.json'),profilePackage);if(!fs.existsSync(path.join(dir,'cordis.yml')))atomic(path.join(dir,'cordis.yml'),'[]\n');
  const ai=resolveProvider(config,id),personaFile=path.join(data,'persona/library',(b.persona||'default')+'.txt');
  if(!fs.existsSync(personaFile)&&b.enabled)throw Error(id+': 人格文件不存在：'+b.persona);
  const persona=fs.existsSync(personaFile)?fs.readFileSync(personaFile,'utf8'):'自然群友';
  const patches=[];
  patches.push({id:'agent-presets',config:{default:'qq-chat',roots:[{path:path.join(home,'.agent-presets'),trust:'system'}],includeShippedRoot:false,includeUserRoot:false}});
  if(!official){
   for(const [serverName,file] of [['snowluma','mcp-snowluma-safe.js'],['snowluma-host','mcp-host-server.js']])patches.push({insert:[{id:'mcp-'+serverName,name:'@deepseek-ai/dsh-mcp-client',config:{serverName,transport:'stdio',command:process.execPath,args:[path.join(PROJECT_ROOT,id,'src',file)],toolCallTimeoutMs:725000}}]});
  }else patches.push({id:'im-qqbot',config:{appId:process.env[id.toUpperCase()+'_APP_ID']||'',appSecret:process.env[id.toUpperCase()+'_APP_SECRET']||'',provider:ai.id,model:ai.model,cwd:path.join(data,id,'workspace'),preset:'qq-chat',requireMention:true,access:{c2cMode:'allowlist',c2cAllow:b.admin_ids,groupMode:'allowlist',groupAllow:b.group_ids}}});
  atomic(path.join(dir,'cordis.patch.yml'),JSON.stringify(patches,null,2));
  atomic(path.join(home,'ai.generated.patch.yml'),JSON.stringify(providerPatch(config,id),null,2));
  jsonWrite(path.join(home,'settings.yaml'),{'agent-default-model':{provider:ai.id,model:ai.model,...(ai.profile.reasoning&&ai.profile.reasoning!=='off'?{reasoningEffort:ai.profile.reasoning}:{})}});
  for(const preset of ['qq-chat','qq-chat-v2','debate-speaker']){
   const p=path.join(home,'.agent-presets',preset);fs.mkdirSync(p,{recursive:true});atomic(path.join(p,'preset.yml'),JSON.stringify({name:preset,description:'QQ fleet chat',order:10}));
   const template=readJSON(path.join(PROJECT_ROOT,'deployment/templates',preset==='qq-chat-v2'?'qq-chat-v2.json':'qq-chat.json'));
   for(const e of template)if(e.name==='@deepseek-ai/dsh-persona')e.config.prefix=e.config.prefix.replace('{{PERSONA}}',()=>persona);
   atomic(path.join(p,'agent.cordis.yml'),JSON.stringify(template));fs.copyFileSync(path.join(PROJECT_ROOT,'deployment/templates/qq-tool-restrict.mjs'),path.join(p,'qq-tool-restrict.mjs'));
  }
  if(!official){
   const file=path.join(data,id,'config.json');let prior={};try{prior=readJSON(file);}catch{}
   jsonWrite(file,{...prior,dsh:{baseUrl:'http://127.0.0.1:'+PORTS[id].dsh,provider:ai.id,model:ai.model,reasoningEffort:ai.profile.reasoning||'off'},snowluma:{...prior.snowluma,wsUrl:b.onebot_ws,httpUrl:b.onebot_http,accessToken:process.env[b.onebot_token_env]||'',allowProcessControl:false},ownerQQ:b.admin_ids[0]||'',allow:{private:b.admin_ids,groups:b.group_ids},allowAllWhenEmpty:false,sessionCwd:path.join(data,id,'workspace'),agentPreset:'qq-chat',consolePort:PORTS[id].console,...(b.bridge||{}),socialV2:{...prior.socialV2,...b.bridge?.socialV2,coordinator:{...prior.socialV2?.coordinator,...b.bridge?.socialV2?.coordinator,botId:id}}});
  }
 }
 return {data,registry};
}

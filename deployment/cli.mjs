import fs from 'node:fs';
import path from 'node:path';
import {PROJECT_ROOT} from './paths.mjs';
import {configFile,loadConfig,jsonWrite,prepare,readJSON} from './config.mjs';
import {doctor} from './runtime.mjs';
import {startPanel} from './panel.mjs';
import {installPersona,voiceRequest,assignVoice} from './setup.mjs';
const args=process.argv.slice(2),command=args.shift()||'help';
const option=name=>{const index=args.indexOf('--'+name);return index>=0?args[index+1]:undefined;};
try{
 if(command==='init'){
  if(fs.existsSync(configFile()))throw Error('配置已存在，不会覆盖');
  const config=readJSON(path.join(PROJECT_ROOT,'deployment/config.example.json'));config.mode=option('mode')||'local';config.data_dir=option('data-dir')||'./data';if(config.mode==='cloud')for(const [id,b] of Object.entries(config.bots))if(b.onebot_ws){b.onebot_ws='ws://napcat-'+id+':3001';b.onebot_http='http://napcat-'+id+':3000';}jsonWrite(configFile(),config);
  const env=path.join(path.dirname(configFile()),'.env');if(!fs.existsSync(env))fs.copyFileSync(path.join(PROJECT_ROOT,'deployment/.env.example'),env);
  prepare(loadConfig());console.log('已初始化；所有账号默认停用。编辑部署配置和 .env 后运行 doctor/start。');
 }else if(command==='prepare'){prepare(loadConfig());console.log('部署配置与运行目录已生成，不启动机器人');}
 else if(command==='doctor'){const checks=await doctor(loadConfig());console.log(JSON.stringify(checks,null,2));if(checks.some(c=>!c.ok))process.exitCode=1;}
 else if(command==='start')await startPanel(loadConfig(),{autoStart:!args.includes('--panel-only')});
 else if(command==='export'){const {exportSource}=await import('./export.mjs');console.log(JSON.stringify(await exportSource(option('out')),null,2));}
 else if(command==='persona'){
  const file=option('file');if(!file)throw Error('需要 --file 人格文本路径');
  installPersona(loadConfig(),{id:option('id'),name:option('name'),text:fs.readFileSync(path.resolve(file),'utf8').replace(/^\uFEFF/,''),bots:(option('bots')||'').split(',').filter(Boolean),overwrite:args.includes('--overwrite')});console.log('人格仅保存到私有 data；重启所选机器人后生效');
 }else if(command==='voice-assign'){
  await assignVoice(loadConfig(),{bot:option('bot'),profileId:option('profile'),replyMode:option('reply-mode')||'text'});console.log('已分配使用者自己的音色；重启该机器人后生效');
 }else if(command.startsWith('voice-')){
  loadConfig();const action=command.slice(6);let body;
  if(action==='create'){const audio=[];for(let i=0;i<args.length;i++)if(args[i]==='--audio'&&args[i+1])audio.push(path.resolve(args[++i]));body={projectId:option('id'),name:option('name'),speaker:option('speaker')||'speaker',sourceLanguage:option('language')||'ja',audioPaths:audio};}
  else if(['prepare','train','cancel'].includes(action)){if(action==='train'&&!args.includes('--reviewed'))throw Error('请先审核 review.csv，再带 --reviewed 开始训练');body={projectId:option('id')};}
  console.log(JSON.stringify(await voiceRequest(action,body),null,2));
 }
 else if(command==='check-ai'){
  const {checkProvider}=await import('./check-ai.mjs');console.log(JSON.stringify(await checkProvider(loadConfig(),option('provider')||'main'),null,2));
 }else console.log('命令：init [--mode local|cloud]、prepare、doctor、start [--panel-only]、check-ai --provider main、export [--out 新目录]；persona --id ID --file 文件 --bots bot3,bot4；voice-create --id ID --audio 文件 [--audio 文件] --language ja|zh；voice-prepare/voice-train/voice-cancel --id ID（训练需 --reviewed）；voice-projects、voice-profiles、voice-assign --bot bot6 --profile ID [--reply-mode text|smart|always]。私有配置可用 QQBOT_DEPLOY_CONFIG 指定。');
}catch(e){console.error(e.message);process.exitCode=1;}

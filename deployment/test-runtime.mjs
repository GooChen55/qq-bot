import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {prepare,readJSON} from './config.mjs';
import {PROJECT_ROOT} from './paths.mjs';
import {dshEntry} from './runtime.mjs';
import {NodeApiClient,unwrap,createTurnCollector} from '../bot4/src/dsh-client.js';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-ai-live-'));
let child,bridge,onebot,logs='',bridgeLogs='',requests=0,api,sessionId;
const mock=http.createServer(async(req,res)=>{
 let text='';for await(const b of req)text+=b;const body=JSON.parse(text||'{}');
 assert.equal(req.url,'/v1/chat/completions');assert.equal(body.model,'fixture-model');assert.equal(req.headers.authorization,'Bearer fixture-key');requests++;
 res.setHeader('Content-Type','text/event-stream');
 const part=(delta,finish)=>({id:'fixture',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model,choices:[{index:0,delta,finish_reason:finish}]});
 res.write('data: '+JSON.stringify(part({role:'assistant',content:'OK_DEPLOY'},null))+'\n\n');res.write('data: '+JSON.stringify(part({},'stop'))+'\n\n');res.end('data: [DONE]\n\n');
});
try{
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const config=readJSON(path.join(PROJECT_ROOT,'deployment/config.example.json'));config.data_dir=temp;config.bots.bot4.admin_ids=['123456789'];config.providers.main={...config.providers.main,base_url:'http://127.0.0.1:'+mock.address().port+'/v1',model:'fixture-model',api_key:'fixture-key'};
 prepare(config);const home=path.join(temp,'bot4/dsh-home'),port=19084;
 child=spawn(process.execPath,[dshEntry(),'--profile','web','--patch',path.join(home,'ai.generated.patch.yml'),'--no-open','--host','127.0.0.1','--port',String(port)],{cwd:PROJECT_ROOT,windowsHide:true,env:{...process.env,DSH_HOME:home,QQBOT_DATA_DIR:temp,QQBOT_STATE_DIR:path.join(temp,'bot4/state'),QQBOT_BOT_CONFIG:path.join(temp,'bot4/config.json')},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 let token;for(let n=0;n<120;n++){token=/[?&]token=([A-Za-z0-9_%.-]+)/.exec(logs)?.[1];if(token)break;if(child.exitCode!==null)throw Error('DSH start failed: '+logs.slice(0,3000));await new Promise(r=>setTimeout(r,500));}assert(token,'DSH access URL not produced; '+logs.slice(0,2000));
 fs.writeFileSync(path.join(temp,'bot4/state/dsh-token'),decodeURIComponent(token),{mode:0o600});
 api=new NodeApiClient('http://127.0.0.1:'+port,{token:decodeURIComponent(token)});
 const workspace=unwrap(await api.workspace.create({path:path.join(temp,'bot4/workspace')}),'workspace');
 const session=unwrap(await api.sessions.create({workspaceId:workspace.workspace.workspaceId,agentPreset:'qq-chat'}),'session');sessionId=session.sessionId;
 unwrap(await api.sessions.selectModel({sessionId,provider:'fleet-main',model:'fixture-model'}),'model selection');
 unwrap(await api.sessions.prompt({sessionId,mode:'queue',content:[{type:'text',text:'Say OK_DEPLOY.'}]}),'prompt');
 const collector=createTurnCollector();let last=0,result;
 for(let n=0;n<120&&!result;n++){
  const listing=unwrap(await api.sessions.list({_request:{}}),'list');const seq=listing.items?.find(s=>s.sessionId===sessionId)?.projections?.asOfSeq||0;
   if(seq>last){for(const record of await api.fetchNewRecords(sessionId,last,seq)){last=Math.max(last,record.event?.seq||0);const done=collector.push(record.event);if(done)result=done;}}
  if(!result)await new Promise(r=>setTimeout(r,500));
 }
 assert.equal(result?.text?.trim(),'OK_DEPLOY','Actual custom-provider response did not finish; requests='+requests+'; result='+JSON.stringify(result)+'; '+logs.split(/\r?\n/).filter(l=>/error|failed|credential/i.test(l)).slice(-8).join('\n').replace(/([?&]token=)[^\s]+/g,'$1[redacted]'));assert(requests>0);
 console.log('PASS actual DSH agent → custom base_url/api_key/model → streaming mock AI → completed reply; no QQ sends');
 const {WebSocketServer}=createRequire(new URL('../bot4/package.json',import.meta.url))('ws');
 onebot=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>onebot.once('listening',r));
 const sent=[];let socket;
 onebot.on('connection',ws=>{socket=ws;ws.on('message',bytes=>{const req=JSON.parse(bytes);if(/^send_.*msg$/.test(req.action))sent.push(JSON.stringify(req.params));const data=req.action==='get_login_info'?{user_id:987654321,nickname:'fixture'}:req.action.startsWith('send_')?{message_id:1001}:[];ws.send(JSON.stringify({status:'ok',retcode:0,data,echo:req.echo}));});});
 const bridgeFile=path.join(temp,'bot4/config.json'),bc=readJSON(bridgeFile);bc.dsh.baseUrl='http://127.0.0.1:'+port;bc.snowluma.wsUrl='ws://127.0.0.1:'+onebot.address().port;bc.consolePort=19192;bc.social={enabled:false};bc.socialV2={...bc.socialV2,enabled:false,sticker:{enabled:false}};bc.slang={enabled:false};bc.sendDelayMs=0;fs.writeFileSync(bridgeFile,JSON.stringify(bc));
 bridge=spawn(process.execPath,[path.join(PROJECT_ROOT,'bot4/src/bridge.js')],{cwd:PROJECT_ROOT,windowsHide:true,env:{...process.env,QQBOT_DATA_DIR:temp,QQBOT_STATE_DIR:path.join(temp,'bot4/state'),QQBOT_BOT_CONFIG:bridgeFile},stdio:['ignore','pipe','pipe']});
 bridge.stdout.on('data',b=>bridgeLogs+=b);bridge.stderr.on('data',b=>bridgeLogs+=b);
 for(let n=0;n<60&&!bridgeLogs.includes('桥接已启动');n++){if(bridge.exitCode!==null)throw Error('Fixture bridge failed: '+bridgeLogs.slice(-2000));await new Promise(r=>setTimeout(r,500));}
 assert(socket,'fixture OneBot did not connect');
 socket.send(JSON.stringify({time:Math.floor(Date.now()/1000),self_id:987654321,post_type:'message',message_type:'private',sub_type:'friend',message_id:1,user_id:123456789,message:[{type:'text',data:{text:'/你好'}}],raw_message:'/你好',sender:{user_id:123456789,nickname:'fixture'}}));
 for(let n=0;n<120&&!sent.some(s=>s.includes('OK_DEPLOY'));n++)await new Promise(r=>setTimeout(r,500));
 if(!sent.some(s=>s.includes('OK_DEPLOY'))){const list=unwrap(await api.sessions.list({_request:{}}),'fixture diagnosis');for(const s of list.items||[]){const seq=s.projections?.asOfSeq||0;const records=await api.fetchNewRecords(s.sessionId,0,seq);console.log('fixture events',s.sessionId,records.map(r=>({type:r.event?.type,data:r.event?.data})));}console.log('fixture sends',sent,'model requests',requests,'dsh errors',logs.split(/\r?\n/).filter(l=>/error|failed/i.test(l)).slice(-8));}
 assert(sent.some(s=>s.includes('OK_DEPLOY')),'QQ bridge did not return custom AI reply: '+bridgeLogs.slice(-3500));
 console.log('PASS actual bot4 bridge → isolated fake OneBot → custom AI → fake QQ reply; no real QQ network');
}finally{
 if(api&&sessionId)await api.sessions.cancel({sessionId}).catch(()=>{});
 for(const p of [bridge,child])if(p&&p.exitCode===null){if(process.platform==='win32')await promisify(execFile)('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});else p.kill();if(p.exitCode===null)await new Promise(r=>{p.once('exit',r);setTimeout(r,2000).unref();});}
 if(onebot){for(const ws of onebot.clients)ws.terminate();await new Promise(r=>onebot.close(r));}
 await new Promise(r=>mock.close(r));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}

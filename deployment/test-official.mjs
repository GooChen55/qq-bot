import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepare,readJSON} from './config.mjs';
import {patchOfficialSDK} from './official-hooks.mjs';
import {PROJECT_ROOT} from './paths.mjs';
import {dshEntry} from './runtime.mjs';
const run=promisify(execFile),temp=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-official-'));
try{
 const config=readJSON(path.join(PROJECT_ROOT,'deployment/config.example.json'));config.data_dir=temp;config.bots.bot2.admin_ids=['123456789'];prepare(config);
 const home=path.join(temp,'bot2/home'),dir=path.join(home,'profiles/qqbot2');
 const cached=path.join(PROJECT_ROOT,'dist/official-sdk-qa/node_modules');
 if(fs.existsSync(cached))fs.cpSync(cached,path.join(dir,'node_modules'),{recursive:true});
 else await run(process.platform==='win32'?'npm.cmd':'npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:dir,shell:process.platform==='win32',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
 patchOfficialSDK(dir);patchOfficialSDK(dir);
 for(const file of ['inbound','outbound'])await run(process.execPath,['--check',path.join(dir,'node_modules/@tencent-connect/dsh-qqbot/dist/transport',file+'.js')]);
 const env={...process.env,DSH_HOME:home,QQBOT_DATA_DIR:temp,QQBOT_BOT_ID:'bot2',BOT2_APP_ID:'fixture-id',BOT2_APP_SECRET:'fixture-secret'};
 const {stdout}=await run(process.execPath,[dshEntry(),'--profile','qqbot2','--patch',path.join(home,'ai.generated.patch.yml'),'--dump-config'],{cwd:PROJECT_ROOT,env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});assert(stdout.includes('fleet-main'));assert(stdout.includes('im-qqbot'));
 const script=`const a=await import('./deployment/official-adapter.mjs');const sent=[];const bot={sendMarkdown:async(t,text)=>sent.push(text)};const base={scope:'group',peerId:'987654321',replyTarget:{},bot};const denied=await a.fleetInbound({...base,msg:{senderId:'111111111',content:'hello'}});if(!denied.consumed||sent.length)throw Error('deny guard failed');const help=await a.fleetInbound({...base,msg:{senderId:'123456789',content:'/玩法 帮助',messageId:'fixture'}});if(!help.consumed||!sent.length||!sent[0].includes('bot2'))throw Error('activity routing failed');console.log('PASS official sender guard and bot2 game command routing');`;
 const result=await run(process.execPath,['--input-type=module','-e',script],{cwd:PROJECT_ROOT,env,windowsHide:true});console.log(result.stdout.trim());
 console.log('PASS pinned official SDK patch, idempotence and actual DSH profile composition; no QQ login');
}finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});}

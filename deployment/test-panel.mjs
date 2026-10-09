import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {PROJECT_ROOT} from './paths.mjs';
import {prepare,readJSON} from './config.mjs';
import {startPanel} from './panel.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-panel-'));let panel;
try{
 const config=readJSON(path.join(PROJECT_ROOT,'deployment/config.example.json'));config.data_dir=temp;config.providers.main.api_key='fixture-panel-key';prepare(config);
 process.env.QQBOT_DEPLOY_CONFIG=path.join(temp,'config.json');
 panel=await startPanel(config,{autoStart:false,port:0});
 const base='http://127.0.0.1:'+panel.server.address().port,token=fs.readFileSync(panel.tokenFile,'utf8');
 const request=(route,body,extra={})=>fetch(base+'/api/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:body?JSON.stringify(body):undefined});
 const denied=await fetch(base+'/api/status');assert.equal(denied.status,401);
 const status=await(await request('status')).json();assert(!JSON.stringify(status).includes('fixture-panel-key'));assert.equal(status.processes.length,0);
 let saved=await request('config',status.config);assert.equal(saved.status,200);assert.equal(readJSON(process.env.QQBOT_DEPLOY_CONFIG).providers.main.api_key,'fixture-panel-key');
 const cross=await request('config',status.config,{Origin:'https://other.example'});assert.equal(cross.status,400);
 const disabled=await request('start',{bot:'bot4'});assert.equal(disabled.status,400);
 const scripts=[...fs.readFileSync(path.join(PROJECT_ROOT,'deployment/panel.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];for(const s of scripts)new vm.Script(s[1]);
 console.log('PASS panel authentication, masked keys, save/preserve key, cross-origin rejection, disabled-bot guard and frontend syntax');
}finally{if(panel)await panel.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});}

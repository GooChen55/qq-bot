import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validate,prepare,dataRoot,providerPatch,redacted,readJSON,configFile} from './config.mjs';
import {PROJECT_ROOT} from './paths.mjs';
import {dshEntry} from './runtime.mjs';
import {scanSource,sourceFiles} from './export.mjs';
import {checkProvider} from './check-ai.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-deploy-'));
try{
 const config=readJSON(path.join(PROJECT_ROOT,'deployment/config.example.json'));config.data_dir=temp;
 assert.equal(validate(config),config);
 const fixtureKey=['fixture','not','a','real','key'].join('-');
 config.providers.second={...config.providers.main,base_url:'https://another.example/v1',model:'other-model',api_key:fixtureKey};
 config.bots.bot4.provider='second';
 const patch=providerPatch(config,'bot4');assert.equal(patch[1].config.provider,'fleet-second');assert.equal(patch[1].config.model,'other-model');assert(!JSON.stringify(patch).includes('fixture-not-a-real-key'));
 assert(!JSON.stringify(redacted(config)).includes('fixture-not-a-real-key'));
 assert.throws(()=>validate({...config,providers:{main:{...config.providers.main,base_url:'file:///private'}}}),/base_url/);
 const prepared=prepare(config);assert.equal(prepared.data,temp);
 const home=path.join(temp,'bot4/dsh-home');
 const profile=readJSON(path.join(temp,'bot4/config.json'));assert.equal(profile.dsh.provider,'fleet-second');assert.equal(profile.dsh.model,'other-model');assert.equal(profile.allowAllWhenEmpty,false);assert.equal(profile.socialV2.coordinator.botId,'bot4');
 const wake=readJSON(path.join(temp,'shared/wake-access.json'));assert.deepEqual(wake.bots.bot4.privateUsers,[]);
 const keep=path.join(temp,'bot4/state/fixture.txt');fs.writeFileSync(keep,'keep');config.bots.bot4.admin_ids=['123456789'];prepare(config);assert.equal(fs.readFileSync(keep,'utf8'),'keep');assert.deepEqual(readJSON(path.join(temp,'shared/wake-access.json')).bots.bot4.privateUsers,['123456789']);
 let request;await checkProvider(config,'second',{fetchImpl:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})};}});
 assert.equal(request.url,'https://another.example/v1/chat/completions');assert.equal(JSON.parse(request.options.body).model,'other-model');assert.equal(request.options.headers.Authorization,'Bearer fixture-not-a-real-key');
 const files=sourceFiles();assert(files.includes('deployment/local/start.cmd'));assert(files.includes('bot4/public/console.html'));assert(!files.some(f=>f.includes('/state/')||f.endsWith('/config.json')||f.includes('/home/')||f.includes('voice-data')));assert.deepEqual(scanSource(files),[]);
 if(!process.argv.includes('--no-dsh')){
  const {stdout}=await promisify(execFile)(process.execPath,[dshEntry(),'--profile','web','--patch',path.join(home,'ai.generated.patch.yml'),'--dump-config'],{cwd:PROJECT_ROOT,env:{...process.env,DSH_HOME:home,QQBOT_DATA_DIR:temp,QQBOT_STATE_DIR:path.join(temp,'bot4/state'),QQBOT_BOT_CONFIG:path.join(temp,'bot4/config.json')},windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  assert(stdout.includes('fleet-second'));assert(stdout.includes('other-model'));assert(!stdout.includes('fixture-not-a-real-key'));
  console.log('PASS actual pinned DSH composition with custom provider, base URL and model');
 }
 console.log('PASS isolated deployment config, provider/key separation, preserved state, deny defaults, protocol request and release allowlist');
}finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});}

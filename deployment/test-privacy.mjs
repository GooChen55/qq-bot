import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import vm from 'node:vm';
import {PROJECT_ROOT} from './paths.mjs';
import {prepare,readJSON,jsonWrite} from './config.mjs';
import {collectPrivateValues} from './privacy.mjs';
import {scanSource,sourceFiles} from './export.mjs';
import {installPersona,voiceRequest,assignVoice} from './setup.mjs';
import {coverModels,coverModel,importCoverModel} from '../shared/cover-models.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-privacy-')),previousConfig=process.env.QQBOT_DEPLOY_CONFIG;
try{
 const account='123456789',voiceId='my_'+'voice_fixture',key=crypto.randomBytes(24).toString('hex'),personaText='Private fixture persona '+crypto.randomUUID();
 const inventory=path.join(temp,'inventory');
 jsonWrite(path.join(inventory,'bots.json'),{fleet:[{id:'bot6',accountQq:account}]});
 jsonWrite(path.join(inventory,'bot6/config.json'),{snowluma:{accessToken:key},socialV2:{voice:{defaultProfileId:voiceId}}});
 jsonWrite(path.join(inventory,'shared/voice-data/profiles',voiceId+'.json'),{id:voiceId,name:'my_fixture_name'});
 jsonWrite(path.join(inventory,'persona/library/manifest.json'),{personas:[{id:'my_persona',name:'My persona',file:'my_persona.txt'}]});fs.writeFileSync(path.join(inventory,'persona/library/my_persona.txt'),personaText);
 const values=collectPrivateValues(inventory);assert(values.some(v=>v.value===account));assert(values.some(v=>v.value===key));assert(values.some(v=>v.value===voiceId));assert(values.some(v=>v.value===personaText));
 fs.writeFileSync(path.join(inventory,'leak.js'),'const leaked='+JSON.stringify({account,key,voiceId,personaText})+';');
 const issues=scanSource(['leak.js'],inventory,{privateValues:values});assert(issues.some(i=>i.rule==='private-account-or-id'));assert(issues.some(i=>i.rule==='private-credential'));assert(issues.some(i=>i.rule==='private-persona-text'));assert(!JSON.stringify(issues).includes(key));
 assert.deepEqual(scanSource(sourceFiles()),[]);
 assert(sourceFiles().includes('LICENSE'));assert(fs.readFileSync(path.join(PROJECT_ROOT,'LICENSE'),'utf8').includes('第三方'));assert(fs.readFileSync(path.join(PROJECT_ROOT,'PUBLIC-README.md'),'utf8').includes('(LICENSE)'));
 for(const id of ['bot3','bot4','bot5','bot6']){assert(sourceFiles().includes(id+'/.npmrc'));assert.equal(fs.readFileSync(path.join(PROJECT_ROOT,id,'.npmrc'),'utf8').trim(),'legacy-peer-deps=true');assert(!readJSON(path.join(PROJECT_ROOT,id,'package.json')).dependencies?.['qqbot-fleet']);assert(!readJSON(path.join(PROJECT_ROOT,id,'package-lock.json')).packages?.['node_modules/qqbot-fleet']);}
 const publishFixture=path.join(temp,'publish');fs.mkdirSync(path.join(publishFixture,'deployment'),{recursive:true});
 fs.writeFileSync(path.join(publishFixture,'safe.mjs'),'export const ready=true;');fs.writeFileSync(path.join(publishFixture,'unreviewed.mjs'),'not publishable');
 jsonWrite(path.join(publishFixture,'deployment/public-files.json'),['safe.mjs']);assert.deepEqual(sourceFiles(publishFixture),['safe.mjs']);
 for(const unsafe of ['data/private.json','../escape.mjs','./safe.mjs','safe.mjs:stream']){jsonWrite(path.join(publishFixture,'deployment/public-files.json'),[unsafe]);assert.throws(()=>sourceFiles(publishFixture));}
 jsonWrite(path.join(publishFixture,'deployment/public-files.json'),['missing.mjs']);assert.throws(()=>sourceFiles(publishFixture));
 const config=readJSON(path.join(PROJECT_ROOT,'deployment/config.example.json'));config.data_dir=path.join(temp,'fresh');process.env.QQBOT_DEPLOY_CONFIG=path.join(temp,'private-config.json');prepare(config);
 assert(Object.values(config.bots).every(b=>!b.enabled&&!b.admin_ids.length&&!b.group_ids.length));assert(readJSON(path.join(config.data_dir,'bots.json')).fleet.every(b=>!b.accountQq));
 assert(Object.values(readJSON(path.join(config.data_dir,'shared/voice-fleet.json')).bots).every(b=>b.enabled===false&&!b.profileId));assert.deepEqual(coverModels(path.join(config.data_dir,'shared/cover-data')),[]);
 assert.deepEqual(readJSON(path.join(config.data_dir,'persona/library/manifest.json')).personas.map(p=>p.id),['default']);
 let next=installPersona(config,{id:'my_persona',text:personaText,bots:['bot6']});assert.equal(next.bots.bot6.persona,'my_persona');assert.throws(()=>installPersona(next,{id:'my_persona',text:'do not overwrite'}),/已存在/);prepare(next);assert(fs.readFileSync(path.join(config.data_dir,'bot6/dsh-home/.agent-presets/qq-chat/agent.cordis.yml'),'utf8').includes(personaText));
 let request;const mockFetch=async(url,options)=>{request={url,options};return {ok:true,json:async()=>({ok:true,profiles:[{id:voiceId}],projects:[]})};};
 await voiceRequest('prepare',{projectId:voiceId},{fetchImpl:mockFetch});assert(request.url.endsWith('/training/prepare'));
 next=await assignVoice(next,{bot:'bot6',profileId:voiceId,replyMode:'smart'},{fetchImpl:mockFetch});assert.equal(next.bots.bot6.bridge.socialV2.voice.defaultProfileId,voiceId);assert.equal(readJSON(path.join(config.data_dir,'shared/voice-fleet.json')).bots.bot6.profileId,voiceId);
 const weights=path.join(temp,'own.pth');fs.writeFileSync(weights,'synthetic QA, not a model');const coverData=path.join(config.data_dir,'shared/cover-data');const model=importCoverModel(coverData,{id:voiceId,pth:weights});assert.equal(model.id,voiceId);assert.equal(model.rightsConfirmed,false);assert(fs.existsSync(model.pth));assert.equal(coverModel(coverData,voiceId).id,voiceId);assert.throws(()=>importCoverModel(coverData,{id:voiceId,pth:weights}),/已存在/);assert.equal(coverModel(coverData,'../escape'),null);
 next.bots.bot6.qq='987654321';prepare(next);
 const code=`import assert from 'node:assert/strict';const a=await import('./shared/fleet-identity.mjs');assert(a.accountMessageAllowed('bot6',{}, {self_id:987654321}));assert(!a.accountMessageAllowed('bot6',{}, {self_id:111111111}));assert(a.fleetAccountQQs().includes('987654321'));`;
 await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{cwd:PROJECT_ROOT,env:{...process.env,QQBOT_DATA_DIR:config.data_dir},windowsHide:true});
 for(const file of ['deployment/panel.html','shared/cover-panel.html'])for(const script of fs.readFileSync(path.join(PROJECT_ROOT,file),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 console.log('PASS private-value leak detection/redacted reports, blank first-run accounts/voices, own persona/voice/model setup, account binding and frontend syntax; private fixtures only');
}finally{if(previousConfig===undefined)delete process.env.QQBOT_DEPLOY_CONFIG;else process.env.QQBOT_DEPLOY_CONFIG=previousConfig;fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});}

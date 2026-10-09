import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {PROJECT_ROOT} from './paths.mjs';
import {atomic} from './config.mjs';
const marker='// qqbot-fleet official hooks v1';
export function patchOfficialSDK(profileDir){
 const root=path.join(profileDir,'node_modules/@tencent-connect/dsh-qqbot');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));if(pkg.version!=='0.5.0')throw Error('官方 SDK 版本未经适配：'+pkg.version);
 const adapter=JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT,'deployment/official-adapter.mjs')).href);
 const patch=(name,transform)=>{
  const file=path.join(root,'dist/transport',name+'.js'),before=fs.readFileSync(file,'utf8');
  if(before.includes(marker))return;
  const after=transform(before);if(after===before)throw Error('官方 SDK 补丁未匹配：'+name);atomic(file,marker+'\n'+after);
 };
 const replace=(text,from,to)=>{if(!text.includes(from))throw Error('官方 SDK 结构变化，拒绝猜测补丁');return text.replace(from,to);};
 patch('inbound',text=>{
  text='import {fleetInbound} from '+adapter+';\n'+text;
  return replace(text,'const agentBody = assembleAgentBody(msg, mwState, scope, logger);',
   'const fleet = await fleetInbound({msg,scope,peerId,replyTarget,bot});\n    if (fleet.consumed) return;\n    const agentBody = fleet.agentPrompt ?? assembleAgentBody(msg, mwState, scope, logger);');
 });
 patch('outbound',text=>{
  text='import {automaticVoicePlan,synthesizeFleetVoiceBuffer,voiceReplyMode,fleetBotId} from '+adapter+';\n'+text;
  text=replace(text,'return this.config.streaming',"return voiceReplyMode(fleetBotId) === 'text' && this.config.streaming");
  text=text.replaceAll('void buffer.flush();',"if (voiceReplyMode(fleetBotId) !== 'text') { const text=buffer.text; buffer.cancel(); void this.send(record,text,'sendVoiceMode'); } else { void buffer.flush(); }");
  return replace(text,'const chunks = chunkMarkdownText(text, this.config.textChunkLimit);',
   `const plan=automaticVoicePlan(fleetBotId,text);\n        if (plan.kind !== 'text') {\n            try { const speech=await synthesizeFleetVoiceBuffer(fleetBotId,plan.speechText); await this.bot.sendVoice(record.replyTarget,{buffer:speech.buffer}); if(plan.kind!=='voice-and-text')return; }\n            catch { this.logger.warn('Automatic voice unavailable; falling back to text'); }\n        }\n        const chunks = chunkMarkdownText(text, this.config.textChunkLimit);`);
 });
}

// Runtime adapter for the pinned official QQ SDK; no credentials are embedded.
import fs from 'node:fs';
import {projectPath} from './paths.mjs';
import {isWakeAllowed} from '../shared/wake-access.mjs';
import {handleBot2ActivityCommand} from '../shared/activity-router.mjs';
import {handleCoverCommand} from '../shared/cover-client.mjs';
import {readCoverMP3Async} from '../shared/cover-onebot-file.mjs';
export {automaticVoicePlan,synthesizeFleetVoiceBuffer,voiceReplyMode} from '../shared/voice-client.mjs';
export const fleetBotId=process.env.QQBOT_BOT_ID||'bot1';
export async function fleetInbound({msg,scope,peerId,replyTarget,bot}){
 const kind=scope==='group'?'group':'private';
 if(!isWakeAllowed(fleetBotId,kind,msg.senderId))return {consumed:true};
 if(fleetBotId==='bot2'){
  let admins=[];try{admins=JSON.parse(fs.readFileSync(projectPath('bot2-admins.json'),'utf8')).openIds||[];}catch{}
  const activity=await handleBot2ActivityCommand({text:msg.content,scope:kind,groupId:peerId,senderId:msg.senderId,isAdmin:admins.map(String).includes(String(msg.senderId)),eventId:msg.messageId});
  if(activity?.consumed){if(activity.response)await bot.sendMarkdown(replyTarget,activity.response);return {consumed:true};}
  if(activity?.agentPrompt)return {agentPrompt:activity.agentPrompt};
 }
 const consumed=await handleCoverCommand({text:msg.content,botId:fleetBotId,kind,explicitTarget:true,
  event:{user_id:msg.senderId,group_id:peerId,message_id:msg.messageId},allowed:true,
  sendText:text=>bot.sendMarkdown(replyTarget,text),
  sendRecord:async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('翻唱语音下载失败：HTTP '+r.status);return bot.sendVoice(replyTarget,{buffer:Buffer.from(await r.arrayBuffer())});},
  sendFile:async(output,fileName)=>bot.sendFile(replyTarget,{buffer:await readCoverMP3Async(output)},{fileName})});
 return {consumed};
}

import crypto from 'node:crypto';
export function parseCover(text){
 const m=/^\/(点歌|翻唱)(?:\s+([\s\S]*))?$/.exec(String(text).trim());
 if(!m)return null;
 const arg=(m[2]||'帮助').trim();
 if(['帮助','列表','状态'].includes(arg))return {action:arg};
 if(arg.startsWith('取消 '))return {action:'取消',id:arg.slice(3).trim()};
 if(arg.startsWith('完整语音 '))return {action:'创建',songId:arg.slice(5).trim(),deliveryMode:'full_voice'};
 return {action:'创建',songId:arg};
}
export function coverOwner({kind,botId,atQQs=[],accounts={},defaultBot='bot6'}){
 if(kind==='private')return botId;
 const targets=Object.entries(accounts).filter(([,qq])=>atQQs.includes(String(qq))).map(([id])=>id);
 return targets.length===1?targets[0]:targets.length===0?defaultBot:null;
}
export function cacheKey(data){return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');}
export function validateSettings(c,fleet){
 if(!c||typeof c.bots!=='object'||Array.isArray(c.bots))throw Error('Invalid bot settings');
 for(const [id,b] of Object.entries(c.bots)){
  if(!fleet.includes(id)||typeof b.enabled!=='boolean'||typeof b.modelId!=='string')throw Error('Invalid bot '+id);
  if(!Number.isInteger(b.pitch)||b.pitch < -12||b.pitch>12)throw Error('Pitch must be -12..12');
  if(b.deliveryMode!==undefined&&!['preview_file','full_voice'].includes(b.deliveryMode))throw Error('Invalid delivery mode');
 }
 if(c.maxSeconds!==undefined&&(!Number.isInteger(c.maxSeconds)||c.maxSeconds<1||c.maxSeconds>900))throw Error('Length must be 1..900 seconds');
 return c;
}

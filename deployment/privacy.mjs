// Private values stay in memory during the audit. Reports never contain them.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
const generic=new Set(['','default','speaker','自然群友','text','smart','always','*']);
export function collectPrivateValues(root){
 const values=new Map();
 const add=(value,kind,mode='literal')=>{if(typeof value!=='string'||generic.has(value)||value.length<5||/^[A-Z_][A-Z0-9_]*$/.test(value))return;values.set(kind+'\0'+value,{value,kind,mode});};
 const walk=(v,key='',parent='')=>{
  if(Array.isArray(v)){for(const child of v)walk(child,key,parent);return;}
  if(v&&typeof v==='object'){for(const [k,child] of Object.entries(v))walk(child,k,parent+'/'+key);return;}
  if(typeof v!=='string')return;
  if(/(?:api_?key|access_?token|appsecret|clientsecret|password|console_?token|^(?:token|secret)$)/i.test(key)&&!/(?:env|url)$/i.test(key))add(v,'private-credential','substring');
  else if(/(?:ownerQQ|accountQq|selfQQ|peerQQ|voiceId|defaultProfileId|profileId|appId)/i.test(key)||/(?:privateUsers|groupUsers|knownBotQQs|openIds|admin_ids|group_ids|mentionRequired|c2cAllow|groupAllow)$/.test(key)||(/\/(?:allow|deny|groups)$/.test(parent)&&/^(?:\d{5,15}|[a-fA-F0-9]{16,64})$/.test(v)))add(v,'private-account-or-id',/^\d{5,15}$/.test(v)?'number':'literal');
 };
 const read=(rel,visit=walk)=>{try{const file=path.join(root,rel),raw=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');visit(/\.ya?ml$/.test(rel)?yaml.load(raw):JSON.parse(raw));}catch{/* Missing optional private data is normal in a fresh clone. */}};
 for(const rel of ['bots.json','bot2-admins.json','shared/wake-access.json','shared/voice-fleet.json','deployment/config.json'])read(rel);
 for(let i=1;i<=6;i++){
  read('bot'+i+'/config.json');
  read('bot'+i+'/'+(i<3?'home':'dsh-home')+'/profiles/'+(i<3?i===1?'qqbot':'qqbot2':'web')+'/cordis.patch.yml');
 }
 for(const rel of ['deployment/.env','.env'])try{for(const line of fs.readFileSync(path.join(root,rel),'utf8').split(/\r?\n/)){const m=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);if(m&&/KEY|TOKEN|SECRET|PASSWORD|APP_ID/.test(m[1]))add(m[2].replace(/^['"]|['"]$/g,''),'private-credential','substring');}}catch{}
 const metadata=(dir,kind,keys)=>{
  try{for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
   if(entry.isSymbolicLink())continue;
   const rel=dir+'/'+entry.name;
   if(entry.isFile()&&entry.name.endsWith('.json'))read(rel,obj=>{for(const key of keys)add(obj?.[key],kind);walk(obj);});
   else if(entry.isDirectory())read(rel+(kind==='private-training-id'?'/project.json':'/model.json'),obj=>{for(const key of keys)add(obj?.[key],kind);walk(obj);});
  }}catch{}
 };
 metadata('shared/voice-data/profiles','private-voice-id',['id','name','speaker','referenceText']);
 metadata('shared/voice-data/projects','private-training-id',['id','name','speaker']);
 metadata('shared/cover-data/models','private-cover-id',['id','name']);
 read('shared/cover-data/songs.json',songs=>{for(const s of Array.isArray(songs)?songs:[])for(const key of ['id','title'])add(s[key],'private-song-id');});
 read('persona/library/manifest.json',manifest=>{for(const p of manifest?.personas||[]){for(const key of ['id','name','file'])add(p[key],'private-persona-id');if(typeof p.file==='string'&&/^[\w.-]+$/.test(p.file))try{const text=fs.readFileSync(path.join(root,'persona/library',p.file),'utf8').trim();if(text.length>=24)add(text,'private-persona-text','substring');}catch{}}});
 return [...values.values()];
}
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function privateContentIssues(value,privateValues){
 const kinds=new Set();
 for(const item of privateValues){
  const needle=escape(item.value);
  const found=item.mode==='number'?new RegExp('(?<!\\d)'+needle+'(?!\\d)').test(value):item.mode==='substring'?value.includes(item.value):new RegExp('["\'`]'+needle+'["\'`]').test(value);
  if(found)kinds.add(item.kind);
 }
 return [...kinds];
}

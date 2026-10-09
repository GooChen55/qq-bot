import fs from 'node:fs';
import {projectPath} from '../deployment/paths.mjs';
const qq=value=>/^\d{5,15}$/.test(String(value??''))?String(value):'';
let cached=[],stamp=-1;
function fleet(){try{const file=projectPath('bots.json'),mtime=fs.statSync(file).mtimeMs;if(mtime!==stamp){const list=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')).fleet;cached=Array.isArray(list)?list:[];stamp=mtime;}return cached;}catch{cached=[];stamp=-1;return [];}}
/** Account numbers are private runtime configuration, never source defaults. */
export function fleetAccountQQs(extra=[]){return [...new Set([...fleet().map(b=>b.accountQq),...(Array.isArray(extra)?extra:[])].map(qq).filter(Boolean))];}
export function expectedAccountQQ(botId,config={}){return qq(config.accountQq||config.qq)||qq(fleet().find(b=>b.id===botId)?.accountQq);}
export function accountMessageAllowed(botId,config,event){const expected=expectedAccountQQ(botId,config);return !expected||qq(event?.self_id)===expected;}

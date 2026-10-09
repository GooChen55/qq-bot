import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const PROJECT_ROOT=path.resolve(process.env.QQBOT_ROOT||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
export const DATA_ROOT=process.env.QQBOT_DATA_DIR?path.resolve(process.env.QQBOT_DATA_DIR):null;
export function projectPath(relative=''){
 const rel=String(relative).replaceAll('\\','/').replace(/^\/+/, '');
 if(rel.split('/').includes('..'))throw Error('Relative project path cannot escape root');
 const persistent=/^(runtime(?:\/|$)|persona(?:\/|$)|share(?:\/|$)|shared\/(?:[^/]+\.json|voice-data(?:\/|$)|cover-data(?:\/|$)|stickers(?:\/|$)|debate-relay(?:\/|$))|debate\/state(?:\/|$)|bot[1-6]\/(?:config\.json$|state(?:\/|$)|roles(?:\/|$)|home(?:\/|$)|dsh-home(?:\/|$)|workspace(?:\/|$))|(?:bots|bot2-admins|host-location)\.json$)/.test(rel);
 const result=path.join(DATA_ROOT&&persistent?DATA_ROOT:PROJECT_ROOT,rel);
 return !rel||rel.endsWith('/')?result+path.sep:result;
}
export function executable(name,override,bundled){
 if(process.env[override])return process.env[override];
 return process.platform==='win32'&&bundled?projectPath(bundled):name;
}

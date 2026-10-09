import fs from 'node:fs';
import path from 'node:path';
export function readCoverMP3(output){
 if(!/^[a-f0-9]{64}\.mp3$/.test(output))throw Error('Invalid cover output');
 return fs.readFileSync(path.join(projectPath("shared/cover-data/outputs"),output));
}
const downloads=new Map();
export async function readCoverMP3Async(output){await ensureCoverOutput(output);return readCoverMP3(output);}
export async function ensureCoverOutput(output){
 if(!/^[a-f0-9]{64}\.mp3$/.test(output))throw Error('Invalid cover output');
 const file=projectPath('shared/cover-data/outputs/'+output);if(fs.existsSync(file))return file;
 if(!process.env.COVER_SERVICE_URL)throw Error('完整 MP3 不存在');
 if(downloads.has(output))return downloads.get(output);
 const pending=(async()=>{
  const response=await fetch(process.env.COVER_SERVICE_URL.replace(/\/+$/,'')+'/audio/'+output,{headers:process.env.COVER_API_KEY?{Authorization:'Bearer '+process.env.COVER_API_KEY}:{},signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error('翻唱文件下载失败：HTTP '+response.status);
  const parts=[];let length=0;for await(const b of response.body){length+=b.length;if(length>200*1024*1024)throw Error('翻唱文件超过 200 MB');parts.push(b);}
  if(length<128)throw Error('翻唱文件不完整');fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,Buffer.concat(parts));fs.renameSync(tmp,file);return file;
 })();downloads.set(output,pending);try{return await pending;}finally{downloads.delete(output);}
}
export async function uploadCoverFile(bot,kind,id,output,name) {
 if(!/^[a-f0-9]{64}\.mp3$/.test(output))throw Error('Invalid cover output');
 const file=await ensureCoverOutput(output);
 if(!fs.existsSync(file))throw Error('完整 MP3 不存在');
 const action=kind==='group'?'upload_group_file':'upload_private_file';
 const params={file,name:String(name||'翻唱.mp3').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,110),
  ...(kind==='group'?{group_id:Number(id)}:{user_id:Number(id)})};
 // Only one submission: do not switch transports and accidentally upload twice.
 const reply=await bot.request(action,params,{timeoutMs:120000});
 if(!reply||reply.status!=='ok'||reply.retcode!==0)throw Error(reply?.wording||'完整 MP3 上传失败');
 return reply.data;
}
import {projectPath} from "../deployment/paths.mjs";

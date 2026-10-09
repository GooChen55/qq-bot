import fs from 'node:fs';
import crypto from 'node:crypto';
import {parseCover,coverOwner} from './cover-core.mjs';
import {deliverCover} from './cover-delivery.mjs';
const json=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const base=(process.env.COVER_SERVICE_URL||'http://127.0.0.1:9882').replace(/\/+$/,'');
export async function coverApi(route,body){
 const token=process.env.COVER_API_KEY||fs.readFileSync(projectPath("shared/cover-data/control-token"),'utf8').trim();
 const response=await fetch(base+'/api/'+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(route.startsWith('job?')?30000:15000)});
 const data=await response.json();if(!response.ok)throw Error(data.error||'翻唱服务不可用');return data;
}
const pending=new Set();
export async function handleCoverCommand({text,botId,kind,event,allowed,sendText,sendRecord,sendFile,explicitTarget=false}){
 const command=parseCover(text);if(!command)return false;
 const fleet=json(projectPath("bots.json")).fleet;
 const accounts=Object.fromEntries(fleet.filter(b=>b.accountQq).map(b=>[b.id,String(b.accountQq)]));
 const atQQs=(Array.isArray(event.message)?event.message:[]).filter(s=>s.type==='at').map(s=>String(s.data?.qq));
 if(Object.values(accounts).includes(String(event.user_id)))return true;
 if((!explicitTarget&&coverOwner({kind,botId,atQQs,accounts})!==botId)||!allowed)return true;
 try{
  if(command.action==='帮助'){await sendText('翻唱用法：/点歌 列表；/翻唱 歌曲ID（默认短试听＋完整 MP3）；/翻唱 完整语音 歌曲ID；/翻唱 状态；/翻唱 取消 任务ID。群内默认 bot6 接管，明确 @ 时只由被 @ 的机器人处理。可导入完整歌曲或主唱；歌词或伴奏不能单独生成翻唱。整首最长 15 分钟。');return true;}
  const s=command.action==='创建'?null:await coverApi('status');
   if(command.action==='列表'){await sendText(s.songs.length?s.songs.map(v=>`${v.id} · ${v.title}${v.mix?'（整曲自动分离）':v.vocal?'':'（缺少主唱）'}`).join('\n'):'歌曲库还没有音频素材。请在统一控制台 → 共享翻唱设置导入完整歌曲或主唱。');return true;}
   if(command.action==='状态'){await sendText(s.jobs.filter(j=>j.botId===botId).slice(-3).map(j=>`${j.id} · ${j.songId} · ${j.stage||j.status}${j.error?'：'+j.error:''}`).join('\n')||'当前没有翻唱任务。');return true;}
  if(command.action==='取消'){const job=s.jobs.find(j=>j.id===command.id);if(job?.botId!==botId)throw Error('只能取消该机器人的任务');if(!explicitTarget&&String(event.user_id)!==String(json(projectPath(botId+'/config.json')).ownerQQ))throw Error('只有该机器人的管理员可取消任务');await coverApi('cancel',{id:command.id});await sendText('已取消排队任务。');return true;}
  const requestKey=`${botId}:${kind}:${event.group_id||event.user_id}:${event.message_id||event.msg_id||crypto.randomUUID()}`;
  const job=await coverApi('jobs',{botId,songId:command.songId,public:true,requestKey,deliveryMode:command.deliveryMode});
  if(pending.has(job.id))return true;pending.add(job.id);
  if(job.status!=='completed')await sendText(`翻唱任务${job.sharedCompute?'已加入相同歌曲的生成任务':'已排队'}：${job.id}。完成后${job.deliveryMode==='full_voice'?'尝试发送完整语音（失败时提供 MP3）':'发送短语音试听和完整 MP3 文件'}。`);
  void (async()=>{
     try{let j=job;const deadline=Date.now()+75*60*1000;while(Date.now()<deadline){
    if(!j)throw Error('任务记录不存在');
    if(j.status==='completed'){const claim=await coverApi('claim-delivery',{id:j.id});if(claim.claimed)await deliverCover({job:j,base,sendRecord,sendFile,sendText});return;}
    if(['failed','cancelled','interrupted'].includes(j.status))throw Error(j.error||j.status);
    try{j=await coverApi('job?id='+encodeURIComponent(job.id)+'&wait=1');}
    catch(e){if(/timeout|fetch failed/i.test(e.message)){await new Promise(r=>setTimeout(r,1000));continue;}throw e;}
   }throw Error('任务仍未完成，请用 /翻唱 状态 查询');
   }catch(e){await sendText('翻唱未发送：'+e.message).catch(()=>{});}finally{pending.delete(job.id);}
  })();
 }catch(e){await sendText('翻唱暂不可用：'+e.message);}
 return true;
}
import {projectPath} from "../deployment/paths.mjs";

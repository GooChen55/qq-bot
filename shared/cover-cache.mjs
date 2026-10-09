import fs from 'node:fs';
import crypto from 'node:crypto';

export const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fileStamp=file=>{const s=fs.statSync(file);return [s.size,s.mtimeMs,s.ctimeMs,s.ino].join(':');};
// Re-hash only files that changed. Persisted stamps make service restarts cheap.
export function fingerprints(entries={},save=()=>{}) {
 const pending=new Map();
 return async file=>{
  const stamp=fileStamp(file),key=file+'\0'+stamp;
  if(entries[file]?.stamp===stamp)return entries[file].hash;
  if(pending.has(key))return pending.get(key);
  const promise=(async()=>{
   const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);
   if(fileStamp(file)!==stamp)throw Error('文件在读取期间发生变化，请重新提交');
   const hash=h.digest('hex');entries[file]={stamp,hash};save(entries);return hash;
  })();pending.set(key,promise);
  try{return await promise;}finally{pending.delete(key);}
 };
}

// A compute task is shared; each requesting message keeps its own job and claim.
export class CoverQueue {
 constructor({artifacts={},valid,compute,save=()=>{},changed=()=>{},limit=5}) {
  Object.assign(this,{artifacts,valid,compute,save,changed,limit});this.tasks=new Map();this.active=false;
 }
 submit(job,snapshot) {
  const key=snapshot.key,artifact=this.artifacts[key];
  if(artifact&&this.valid(artifact)){
   Object.assign(job,artifact,{cached:true,status:'completed',stage:'成品缓存命中',completedAt:new Date().toISOString()});
   this.changed();return;
  }
  let task=this.tasks.get(key);
  if(!task){
   if(this.tasks.size>=this.limit)throw Error('队列已满，最多 5 项不同的生成任务');
   task={key,snapshot,status:'queued',requests:[]};this.tasks.set(key,task);
  }else {job.sharedCompute=true;if(task.status==='running'){job.startedAt=new Date().toISOString();job.timings={queueMs:0};}}
  job.status=task.status;job.stage=task.stage||'排队等待';job.computeKey=key;
  task.requests.push(job);this.changed();setImmediate(()=>this.drain());
 }
 cancel(job) {
  if(job.status!=='queued')throw Error('仅可取消尚未开始的任务');
  job.status='cancelled';job.stage='已取消';
  const task=this.tasks.get(job.computeKey);
  if(task&&!task.requests.some(j=>j.status==='queued'))this.tasks.delete(task.key);
  this.changed();
 }
 async drain() {
  if(this.active)return;this.active=true;
  try{while(this.tasks.size){
   const task=this.tasks.values().next().value;
   const requests=()=>task.requests.filter(j=>j.status!=='cancelled');
   if(!requests().length){this.tasks.delete(task.key);continue;}
   task.status='running';const start=Date.now();
   for(const j of requests()){j.status='running';j.startedAt=new Date(start).toISOString();j.timings={queueMs:start-Date.parse(j.createdAt)};}
   const progress=stage=>{task.stage=stage;for(const j of requests())j.stage=stage;this.changed();};
   try{
    const result=await this.compute(task.snapshot,progress);
    this.artifacts[task.key]=result;this.save(this.artifacts);
    for(const j of requests())Object.assign(j,result,{status:'completed',stage:'完成',completedAt:new Date().toISOString(),timings:{...j.timings,...result.timings}});
   }catch(e){for(const j of requests())Object.assign(j,{status:'failed',stage:'失败',error:String(e.message)});}
   this.tasks.delete(task.key);this.changed();
  }}finally{this.active=false;}
 }
}

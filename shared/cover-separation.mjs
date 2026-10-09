import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export const separationModels = {
  fast: 'UVR-MDX-NET-Inst_HQ_3.onnx',
  quality: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
};
export const verifiedLegacyWeights = {'UVR-MDX-NET-Inst_HQ_3.onnx':'317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc'};
export function separationKey(sourceHash, model, seconds, modelHash) {
  return crypto.createHash('sha256').update(JSON.stringify(modelHash?{v:2,sourceHash,model,seconds,modelHash}:{v:1, sourceHash, model, seconds})).digest('hex');
}
export async function separateSong({root, data, python, song, seconds, sha, run, ff, progress, releaseWorker}) {
  if (!song.mix) return song;
  const model = separationModels[song.separationModel || 'fast'];
  if (!model) throw Error('Unknown separation model');
  const modelFile=path.join(data,'separation-models',model);
  const modelHash=fs.existsSync(modelFile)?await sha(modelFile):null;
  const sourceHash=await sha(song.mix);
  const key = separationKey(sourceHash, model, seconds,modelHash);
  let dest = path.join(data, 'separation-cache', key);
  if(modelHash&&!fs.existsSync(path.join(dest,'complete.json'))){
    const legacy=path.join(data,'separation-cache',separationKey(sourceHash,model,seconds));
    try{const meta=JSON.parse(fs.readFileSync(path.join(legacy,'complete.json'),'utf8'));
      if(meta.modelHash===modelHash||(!meta.modelHash&&verifiedLegacyWeights[model]===modelHash))dest=legacy;
    }catch{}
  }
  const vocal = path.join(dest, 'vocal.wav'), backing = path.join(dest, 'backing.wav');
  const marker = path.join(dest, 'complete.json');
  if (fs.existsSync(marker) && [vocal,backing].every(f=>fs.existsSync(f)&&fs.statSync(f).size>128)) {
    progress('分离缓存命中');
    return {...song, vocal, backing, separationCached:true};
  }
  // The service's shared queue serializes separation and conversion.
  await releaseWorker();
  fs.mkdirSync(dest,{recursive:true});
  const input = path.join(dest,'input.wav');
  progress('准备整曲音频');
  await run(ff,['-y','-v','error','-i',song.mix,'-t',String(seconds),'-ac','2','-ar','44100',input],{windowsHide:true});
  progress('分离人声与伴奏（首次需加载模型）');
  const log = fs.createWriteStream(path.join(data,'logs/separator.log'),{flags:'a'});
  let backend;
  try {
    await new Promise((resolve,reject)=>{
      const child = spawn(python,[path.join(root,'shared/cover-separator.py'),'--input',input,'--output',dest,
        '--models',path.join(data,'separation-models'),'--model',model],{
        cwd:root,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',
          PATH:path.dirname(ff)+path.delimiter+process.env.PATH}});
      let output='', tail='';
      const timer=setTimeout(()=>{child.kill();reject(Error('人声分离超时；可改用快速模式或缩短音频'));},30*60*1000);
      child.stdout.on('data',b=>{output=(output+b).slice(-10000);});
      child.stderr.on('data',b=>{log.write(b);tail=(tail+b).slice(-1500);});
      child.on('error',e=>{clearTimeout(timer);reject(e);});
      child.on('exit',code=>{clearTimeout(timer);if(code===0){try{backend=JSON.parse(output.trim().split('\n').at(-1));}catch{}resolve();}else {
        let message=tail;try{message=JSON.parse(output.trim().split('\n').at(-1)).error||tail;}catch{}
        reject(Error('人声分离失败：'+message));
      }});
    });
    if (![vocal,backing].every(f=>fs.existsSync(f)&&fs.statSync(f).size>128)) throw Error('分离结果不完整');
    fs.writeFileSync(marker,JSON.stringify({key,model,modelHash:await sha(modelFile),seconds,backend,createdAt:new Date().toISOString()}));
    if(backend)fs.writeFileSync(path.join(data,'separator-backend.json'),JSON.stringify(backend));
    return {...song,vocal,backing,separationCached:false};
  } finally { log.end(); }
}

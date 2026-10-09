import fs from 'node:fs';
import path from 'node:path';
export const validModelId=id=>/^[a-zA-Z0-9_-]{1,60}$/.test(String(id||''));
export function coverModel(data,id){
 if(!validModelId(id))return null;
 try{const m=JSON.parse(fs.readFileSync(path.join(data,'models',id,'model.json'),'utf8').replace(/^\uFEFF/,''));return m.id===id?m:null;}catch{return null;}
}
export function coverModels(data){
 try{return fs.readdirSync(path.join(data,'models'),{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&validModelId(e.name)).map(e=>coverModel(data,e.name)).filter(Boolean);}catch{return [];}
}
export function importCoverModel(data,input){
 const id=String(input.id||'');if(!validModelId(id))throw Error('模型 ID 仅允许英文、数字、横线和下划线');
 const dir=path.join(data,'models',id);if(fs.existsSync(dir))throw Error('模型 ID 已存在，不会覆盖已有权重');
 const sources=[['pth',input.pth,'.pth'],['index',input.index,'.index']];
 if(!input.pth)throw Error('请选择自己训练或有授权的 RVC .pth 权重');
 for(const [,source,extension] of sources)if(source){if(!path.isAbsolute(source)||path.extname(source).toLowerCase()!==extension||!fs.statSync(source).isFile()||fs.statSync(source).size>2*1024**3)throw Error('权重/索引必须为本机文件，大小不超过 2 GB');}
 fs.mkdirSync(dir,{recursive:true});
 const model={id,name:String(input.name||id).slice(0,100),source:String(input.source||'用户自行训练或导入').slice(0,300),rightsConfirmed:input.rightsConfirmed===true};
 for(const [key,source,extension] of sources)if(source){const file=path.join(dir,'model'+extension);fs.copyFileSync(source,file);model[key]=file;}
 fs.writeFileSync(path.join(dir,'model.json'),JSON.stringify(model,null,2)+'\n',{mode:0o600});return model;
}

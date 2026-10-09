import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {PROJECT_ROOT} from './paths.mjs';
import {configFile,loadConfig,validate,redacted,atomic,jsonWrite,dataRoot,prepare} from './config.mjs';
import {doctor,FleetRuntime} from './runtime.mjs';
import {installPersona} from './setup.mjs';
export async function startPanel(config,{autoStart=true,port=Number(process.env.QQBOT_PANEL_PORT)||9990}={}){
 const runtime=new FleetRuntime(config),data=dataRoot(config),tokenFile=path.join(data,'deployment-token');
 fs.mkdirSync(data,{recursive:true});if(!fs.existsSync(tokenFile))atomic(tokenFile,crypto.randomBytes(32).toString('hex'));
 const token=fs.readFileSync(tokenFile,'utf8').trim();
 let busy=false;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(fs.readFileSync(path.join(PROJECT_ROOT,'deployment/panel.html')));}
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'访问令牌不正确'}));}
  try{
   let result;
   if(req.method==='GET'&&url.pathname==='/api/status')result={config:redacted(runtime.config),processes:runtime.status(),data_dir:data};
   else if(req.method==='GET'&&url.pathname==='/api/doctor')result=await doctor(runtime.config);
   else if(req.method==='POST'){
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('仅接受 JSON');
    if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw Error('跨站写入拒绝');
    let text='';for await(const b of req){text+=b;if(text.length>1024*1024)throw Error('请求过大');}const body=JSON.parse(text||'{}');
    if(busy)throw Error('上一项操作仍在执行');busy=true;
    try{
     if(url.pathname==='/api/config'){
      const next=body;
      for(const [id,p] of Object.entries(next.providers||{}))if(p.api_key===undefined&&runtime.config.providers[id]?.api_key)p.api_key=runtime.config.providers[id].api_key;
      validate(next);if(dataRoot(next)!==dataRoot(runtime.config))throw Error('运行中不能变更数据目录，请停止面板后修改配置');
      jsonWrite(configFile(),next);runtime.config=next;result={ok:true,message:'配置已保存；运行中的机器人需点击重启后切换 AI'};
     }else if(url.pathname==='/api/start'){prepare(runtime.config);await runtime.startBot(body.bot);result={ok:true};}
     else if(url.pathname==='/api/persona'){runtime.config=installPersona(runtime.config,body);result={ok:true,message:'人格仅写入私有 data；重启分配的机器人后生效'};}
     else if(url.pathname==='/api/services/start'){prepare(runtime.config);await runtime.startServices();result={ok:true};}
     else if(url.pathname==='/api/services/stop'){await runtime.stopServices();result={ok:true};}
     else if(url.pathname==='/api/stop'){await runtime.stopBot(body.bot);result={ok:true};}
     else if(url.pathname==='/api/restart'){await runtime.stopBot(body.bot);await runtime.startBot(body.bot);result={ok:true};}
     else throw Error('未知操作');
    }finally{busy=false;}
   }else {res.writeHead(404);return res.end();}
   res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));
  }catch(e){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:e.message}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,process.env.QQBOT_PANEL_HOST||'127.0.0.1',resolve);});
 console.log('部署面板：http://127.0.0.1:'+server.address().port+'；访问令牌保存在 '+tokenFile+'（不会输出到日志）');
 if(autoStart){try{await runtime.startServices();}catch(e){console.error('共享服务：'+e.message);}for(const id of Object.keys(config.bots).filter(id=>config.bots[id].enabled))try{await runtime.startBot(id);}catch(e){console.error(id+': '+e.message);}}
 const close=async()=>{await runtime.close();server.close(()=>process.exit(0));};process.once('SIGINT',close);process.once('SIGTERM',close);
 return {server,runtime,tokenFile,close:async()=>{process.off('SIGINT',close);process.off('SIGTERM',close);await runtime.close();await new Promise(r=>server.close(r));}};
}

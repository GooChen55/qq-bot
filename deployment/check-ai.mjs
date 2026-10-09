export async function checkProvider(config,id,{fetchImpl=fetch,env=process.env}={}){
 const p=config.providers[id];if(!p)throw Error('提供方不存在');
 const key=p.api_key||env[p.api_key_env];if(!key)throw Error('未配置提供方密钥');
 const base=p.base_url.replace(/\/+$/,'');let route,body,headers={'Content-Type':'application/json'};
 if((p.api||'openai-completions')==='openai-completions'){route='/chat/completions';headers.Authorization='Bearer '+key;body={model:p.model,messages:[{role:'user',content:'Reply only OK.'}],max_tokens:16,stream:false};}
 else if(p.api==='openai-responses'){route='/responses';headers.Authorization='Bearer '+key;body={model:p.model,input:'Reply only OK.',max_output_tokens:32};}
 else{route=base.endsWith('/v1')?'/messages':'/v1/messages';headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';body={model:p.model,messages:[{role:'user',content:'Reply only OK.'}],max_tokens:16};}
 const r=await fetchImpl(base+route,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('AI 连接检查失败：HTTP '+r.status+'（不输出服务端响应，避免回显密钥）');
 const v=await r.json();const found=v.choices?.[0]?.message?.content||v.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||v.content?.map(x=>x.text||'').join('');
 if(!found)throw Error('连接成功，但响应格式与所选协议不匹配');
 return {ok:true,provider:id,model:p.model,api:p.api||'openai-completions'};
}

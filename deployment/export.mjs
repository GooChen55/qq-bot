import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {PROJECT_ROOT} from './paths.mjs';
import {collectPrivateValues,privateContentIssues} from './privacy.mjs';
// No new directory/file is automatically publishable. Review it, then add its
// relative path to this checked-in allowlist; missing files fail closed.
export function sourceFiles(root=PROJECT_ROOT){
 const files=JSON.parse(fs.readFileSync(path.join(root,'deployment/public-files.json'),'utf8'));
 if(!Array.isArray(files)||new Set(files).size!==files.length)throw Error('发布文件白名单损坏');
 for(const rel of files){
  if(typeof rel!=='string'||path.isAbsolute(rel)||rel.includes('\\')||rel.includes(':')||rel.split('/').some(p=>!p||p==='..'||p==='.'))throw Error('发布白名单路径无效');
  if(/(?:^|\/)(?:data|state|home|dsh-home|workspace|voice-data|cover-data|persona|node_modules|runtimes|backups)(?:\/|$)|(?:^|\/)(?:config\.json|\.env|credentials[^/]*|sessions[^/]*)$/.test(rel))throw Error('发布白名单不能包含私有运行文件');
  let target=root;for(const part of rel.split('/')){target=path.join(target,part);if(fs.lstatSync(target).isSymbolicLink())throw Error('发布源不能包含符号链接：'+rel);}
  if(!fs.statSync(target).isFile())throw Error('发布源不是文件：'+rel);
 }
 return files;
}
export function scanSource(files,root=PROJECT_ROOT,{privateValues=collectPrivateValues(root)}={}){
 const issues=[];
 for(const rel of files){
  const value=fs.readFileSync(path.join(root,rel),'utf8');
  const checks=[['literal-api-key',/\bsk-[A-Za-z0-9_-]{20,}\b/],['private-user-path',/[A-Za-z]:[\\/](?:Users|用户)[\\/][^\s'"\\/]+/i],['literal-secret',/["']?(?:appSecret|api_key|apiKey|accessToken|consoleToken|password)["']?\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]/i],['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['hardcoded-account',/['"]\d{7,15}['"]/],['hardcoded-voice-id',/\b(?:voiceId|defaultProfileId)\s*:\s*['"][^'"]+['"]/]];
  if(/^deployment\/test[^/]*\.mjs$/.test(rel))checks.splice(checks.findIndex(([name])=>name==='hardcoded-account'),1); // Synthetic account fixtures only; known-private matching still applies.
  for(const [rule,re] of checks)if(re.test(value))issues.push({file:rel,rule});
  for(const rule of privateContentIssues(value,privateValues))issues.push({file:rel,rule});
 }
 return issues;
}
export async function exportSource(output){
 const files=sourceFiles(),issues=scanSource(files);if(issues.length)throw Error('发布扫描失败（不回显敏感内容）：'+JSON.stringify(issues));
 const dest=path.resolve(output||path.join(PROJECT_ROOT,'dist','github-source-'+new Date().toISOString().replace(/[:.]/g,'-')));
 if(fs.existsSync(dest))throw Error('目标已存在，不会覆盖：'+dest);
 if(dest===PROJECT_ROOT||PROJECT_ROOT.startsWith(dest+path.sep))throw Error('发布目录不能是项目根目录或其父目录');
 fs.mkdirSync(dest,{recursive:true});
 const manifest=[];
 for(const rel of files){const target=path.join(dest,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(PROJECT_ROOT,rel),target);
  if(rel==='.gitignore')fs.appendFileSync(target,'\n# README is generated from the reviewed public document in this release only.\n!/README.md\n');
  if(/^bot[3-6]\/package\.json$/.test(rel)){const pkg=JSON.parse(fs.readFileSync(target,'utf8'));pkg.scripts=Object.fromEntries(Object.entries(pkg.scripts||{}).filter(([name])=>['start','self-test','postinstall'].includes(name)));fs.writeFileSync(target,JSON.stringify(pkg,null,2)+'\n');}
  manifest.push({file:rel,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});}
 if(fs.existsSync(path.join(dest,'PUBLIC-README.md'))){fs.copyFileSync(path.join(dest,'PUBLIC-README.md'),path.join(dest,'README.md'));manifest.push({file:'README.md',sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dest,'README.md'))).digest('hex')});}
 fs.writeFileSync(path.join(dest,'release-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),sourceOnly:true,privacyChecks:{knownPrivateValues:'passed',hardcodedAccountAndVoiceIds:'passed',runtimeData:'excluded',freshAccountPersonaVoiceSetup:'required'},files:manifest},null,2));
 return {directory:dest,files:files.length,secretScan:'passed',containsAccounts:false,containsHistory:false,containsWeights:false};
}

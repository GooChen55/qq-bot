import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.VOICE_DATA_DIR || projectPath("shared/voice-data"));
const profilesDir = path.join(dataDir, 'profiles');
const generatedDir = path.join(dataDir, 'generated');
const runtimeDir = path.join(dataDir, 'runtime');
const logDir = path.join(dataDir, 'logs');
const projectsDir = path.join(dataDir, 'projects');
const serviceConfigPath = path.join(dataDir, 'service.json');

for (const dir of [profilesDir, generatedDir, runtimeDir, logDir, projectsDir]) fs.mkdirSync(dir, { recursive: true });

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

const serviceConfig = {
  host: '127.0.0.1',
  port: 9881,
  gptApiUrl: 'http://127.0.0.1:9880',
  gptSovitsDir: process.env.GPT_SOVITS_DIR || projectPath("runtimes/GPT-SoVITS-v3lora-20250228"),
  autoStartGptApi: true,
  ttsConfigPath: path.join(runtimeDir, 'tts_infer_v3.yaml'),
  generatedTtlHours: 24,
  ...readJson(serviceConfigPath, {})
};

let activeProfileId = null;
let queue = Promise.resolve();
let gptApiChild = null;
let gptApiState = 'stopped';
let trainingChild = null;
let trainingJob = null;
let lastError = '';

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(logDir, 'voice-service.log'), line + '\n', 'utf8');
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name || profile.id,
    version: profile.version || 'v3',
    speaker: profile.speaker || '',
    sourceLanguage: profile.sourceLanguage || profile.referenceLanguage || 'ja',
    referenceLanguage: profile.referenceLanguage || 'ja',
    supportedTargetLanguages: profile.supportedTargetLanguages || ['ja', 'zh'],
    enabled: profile.enabled !== false,
    notes: profile.notes || ''
  };
}

function loadProfiles() {
  const profiles = [];
  for (const name of fs.readdirSync(profilesDir)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const profile = readJson(path.join(profilesDir, name));
    if (!profile || !/^[a-zA-Z0-9_-]+$/.test(String(profile.id || ''))) continue;
    profile._file = path.join(profilesDir, name);
    profiles.push(profile);
  }
  return profiles.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-CN'));
}

function getProfile(id) {
  const profile = loadProfiles().find((item) => item.id === id && item.enabled !== false);
  if (!profile) throw new Error(`音色不存在或未启用：${id}`);
  for (const key of ['gptWeight', 'sovitsWeight', 'referenceAudio']) {
    if (!profile[key] || !fs.existsSync(profile[key])) throw new Error(`音色 ${id} 缺少 ${key}：${profile[key] || '未配置'}`);
  }
  if (!String(profile.referenceText || '').trim()) throw new Error(`音色 ${id} 缺少 referenceText`);
  return profile;
}

function detectLanguage(text) {
  const value = String(text || '');
  if (/[\u3040-\u30ff]/.test(value)) return 'ja';
  return 'zh';
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(120000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.Exception || `${response.status} ${response.statusText}`);
  return body;
}

async function isGptApiReady() {
  try {
    const response = await fetch(`${serviceConfig.gptApiUrl}/docs`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

function startGptApi() {
  if (gptApiChild || trainingChild || serviceConfig.autoStartGptApi === false) return;
  const python = process.env.VOICE_PYTHON || (process.platform==='win32'?path.join(serviceConfig.gptSovitsDir, 'runtime', 'python.exe'):'python3');
  const apiScript = path.join(here, 'gpt_sovits_v3_api.py');
  if ((path.isAbsolute(python) && !fs.existsSync(python)) || !fs.existsSync(apiScript)) {
    lastError = 'GPT-SoVITS runtime 或 api_v2.py 不存在';
    gptApiState = 'error';
    log(lastError);
    return;
  }
  const logFile = fs.openSync(path.join(logDir, 'gpt-api.log'), 'a');
  const initialProfile = loadProfiles().find((item) => item.enabled !== false);
  const env = {
    ...process.env,
    version: 'v3',
    is_half: 'True',
    ...(initialProfile ? { gpt_path: initialProfile.gptWeight, sovits_path: initialProfile.sovitsWeight } : {})
  };
  delete env.ALL_PROXY;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  gptApiState = 'starting';
  gptApiChild = spawn(python, [apiScript, '-a', '127.0.0.1', '-p', '9880'], {
    cwd: serviceConfig.gptSovitsDir,
    env,
    windowsHide: true,
    stdio: ['ignore', logFile, logFile]
  });
  log(`已启动 GPT-SoVITS API，PID=${gptApiChild.pid}`);
  gptApiChild.once('exit', (code) => {
    log(`GPT-SoVITS API 已退出，code=${code}`);
    gptApiChild = null;
    gptApiState = 'stopped';
    activeProfileId = null;
  });
}

async function stopGptApi() {
  if (gptApiChild && !gptApiChild.killed) {
    gptApiState = 'stopping';
    gptApiChild.kill();
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && await isGptApiReady()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (await isGptApiReady()) throw new Error('无法停止 GPT-SoVITS 推理进程；请先在控制台停止语音服务后重试');
}

function validateProjectId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('项目 ID 只能包含字母、数字、下划线和连字符，最长 64 位');
  return id;
}

function projectSnapshot(id) {
  const projectDir = path.join(projectsDir, id);
  const project = readJson(path.join(projectDir, 'project.json'), {});
  const status = readJson(path.join(projectDir, 'status.json'), { stage: 'new', message: '尚未开始预处理', progress: 0 });
  return {
    id,
    name: project.name || id,
    speaker: project.speaker || '',
    sourceLanguage: project.sourceLanguage || 'ja',
    audioCount: Array.isArray(project.audioPaths) ? project.audioPaths.length : 0,
    reviewPath: project.reviewPath || path.join(projectDir, 'review.csv'),
    projectDir,
    ...status,
    running: trainingJob?.projectId === id
  };
}

function loadProjects() {
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,64}$/.test(entry.name) && fs.existsSync(path.join(projectsDir, entry.name, 'project.json')))
    .map((entry) => projectSnapshot(entry.name))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function launchTraining(mode, projectId) {
  if (trainingChild) throw new Error(`已有训练任务正在运行：${trainingJob.projectId} / ${trainingJob.mode}`);
  const id = validateProjectId(projectId);
  const projectFile = path.join(projectsDir, id, 'project.json');
  if (!fs.existsSync(projectFile)) throw new Error(`训练项目不存在：${id}`);
  await stopGptApi();
  const python = process.env.VOICE_PYTHON || (process.platform==='win32'?path.join(serviceConfig.gptSovitsDir, 'runtime', 'python.exe'):'python3');
  const script = path.join(here, 'voice_training.py');
  if ((path.isAbsolute(python) && !fs.existsSync(python)) || !fs.existsSync(script)) throw new Error('训练运行时或 voice_training.py 不存在');
  const logFilePath = path.join(projectsDir, id, 'training.log');
  const logFile = fs.openSync(logFilePath, 'a');
  trainingJob = { projectId: id, mode, startedAt: new Date().toISOString(), logFile: logFilePath };
  trainingChild = spawn(python, [script, mode, id], {
    cwd: serviceConfig.gptSovitsDir,
    env: { ...process.env, VOICE_DATA_DIR: dataDir, GPT_SOVITS_DIR: serviceConfig.gptSovitsDir },
    windowsHide: true,
    stdio: ['ignore', logFile, logFile]
  });
  trainingJob.pid = trainingChild.pid;
  log(`已启动音色${mode === 'prepare' ? '预处理' : '训练'}：${id}，PID=${trainingChild.pid}`);
  trainingChild.once('exit', (code, signal) => {
    log(`音色任务已退出：${id} / ${mode}，code=${code}，signal=${signal || ''}`);
    trainingChild = null;
    trainingJob = null;
    try { fs.closeSync(logFile); } catch {}
    if (code !== 0) {
      const statusPath = path.join(projectsDir, id, 'status.json');
      const current = readJson(statusPath, {});
      if (!['failed', 'cancelled'].includes(current.stage)) atomicWriteJson(statusPath, { ...current, stage: 'failed', progress: current.progress || 0, message: `任务异常退出（code=${code}）`, updatedAt: new Date().toISOString() });
      lastError = `音色任务失败：${id}`;
    } else {
      lastError = '';
    }
    setTimeout(() => ensureGptApi().catch((error) => { lastError = error.message; log(error.message); }), 1000).unref();
  });
  return { ...trainingJob };
}

function cancelTraining() {
  if (!trainingChild || !trainingJob) return null;
  const job = { ...trainingJob };
  const statusPath = path.join(projectsDir, job.projectId, 'status.json');
  const current = readJson(statusPath, {});
  atomicWriteJson(statusPath, { ...current, stage: 'cancelled', message: '任务已由用户取消', updatedAt: new Date().toISOString() });
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(trainingChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else trainingChild.kill('SIGTERM');
  return job;
}

async function ensureGptApi() {
  if (trainingChild) throw new Error(`音色任务运行中：${trainingJob.projectId} / ${trainingJob.mode}`);
  if (await isGptApiReady()) {
    gptApiState = 'ready';
    return;
  }
  startGptApi();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await isGptApiReady()) {
      gptApiState = 'ready';
      return;
    }
  }
  gptApiState = 'error';
  throw new Error('GPT-SoVITS API 在 120 秒内未就绪，请查看 voice-data/logs/gpt-api.log');
}

async function selectProfile(profileId) {
  const profile = getProfile(profileId);
  await ensureGptApi();
  if (activeProfileId === profileId) return profile;
  await fetchJson(`${serviceConfig.gptApiUrl}/set_gpt_weights?weights_path=${encodeURIComponent(profile.gptWeight)}`);
  await fetchJson(`${serviceConfig.gptApiUrl}/set_sovits_weights?weights_path=${encodeURIComponent(profile.sovitsWeight)}`);
  activeProfileId = profileId;
  lastError = '';
  log(`已切换音色：${profileId}`);
  return profile;
}

async function synthesize({ profileId, text, textLang }) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('text 不能为空');
  if (clean.length > 1500) throw new Error('text 不能超过 1500 字');
  const profile = await selectProfile(profileId);
  const lang = textLang === 'ja' || textLang === 'zh' ? textLang : detectLanguage(clean);
  if (!(profile.supportedTargetLanguages || ['ja', 'zh']).includes(lang)) throw new Error(`音色 ${profileId} 不支持目标语言 ${lang}`);
  const response = await fetch(`${serviceConfig.gptApiUrl}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: clean,
      text_lang: lang,
      ref_audio_path: profile.referenceAudio,
      prompt_text: profile.referenceText,
      prompt_lang: profile.referenceLanguage || 'ja',
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false,
      speed_factor: 1.0,
      seed: -1
    }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GPT-SoVITS 合成失败：${detail || response.status}`);
  }
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.wav`;
  fs.writeFileSync(path.join(generatedDir, fileName), Buffer.from(await response.arrayBuffer()));
  return {
    url: `http://${serviceConfig.host}:${serviceConfig.port}/audio/${fileName}`,
    format: 'wav',
    profileId,
    textLang: lang
  };
}

function enqueue(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function cleanupGenerated() {
  const cutoff = Date.now() - Math.max(1, Number(serviceConfig.generatedTtlHours) || 24) * 3600000;
  for (const name of fs.readdirSync(generatedDir)) {
    const file = path.join(generatedDir, name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const upstreamReady = await isGptApiReady();
      if (upstreamReady) gptApiState = 'ready';
      sendJson(res, { ok: true, state: gptApiState, upstreamReady, activeProfileId, profiles: loadProfiles().filter((p) => p.enabled !== false).map(publicProfile), training: trainingJob, lastError });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/training/projects') {
      sendJson(res, { ok: true, running: trainingJob, projects: loadProjects() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/training/status') {
      const id = validateProjectId(url.searchParams.get('projectId'));
      if (!fs.existsSync(path.join(projectsDir, id, 'project.json'))) { sendJson(res, { ok: false, error: '训练项目不存在' }, 404); return; }
      sendJson(res, { ok: true, running: trainingJob, project: projectSnapshot(id) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/training/create') {
      const body = await readBody(req, 1024 * 1024);
      const id = validateProjectId(body.projectId);
      const audioPaths = Array.isArray(body.audioPaths) ? [...new Set(body.audioPaths.map((item) => path.resolve(String(item || '').trim())).filter(Boolean))] : [];
      if (!audioPaths.length) throw new Error('请至少选择一个音频文件');
      if (audioPaths.length > 200) throw new Error('单个项目最多导入 200 个音频文件');
      const supported = new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg']);
      for (const file of audioPaths) {
        if (!supported.has(path.extname(file).toLowerCase()) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`音频不存在或格式不支持：${file}`);
      }
      const language = String(body.sourceLanguage || 'ja').toLowerCase();
      if (!['ja', 'zh'].includes(language)) throw new Error('源语言只能是 ja 或 zh');
      const projectDir = path.join(projectsDir, id);
      const projectFile = path.join(projectDir, 'project.json');
      if (fs.existsSync(projectFile)) throw new Error(`项目 ID 已存在：${id}`);
      fs.mkdirSync(projectDir, { recursive: true });
      // Persist selected files now: later preprocessing must not depend on removable/external inputs.
      const inputDir = path.join(projectDir, 'inputs', crypto.randomUUID());
      await fs.promises.mkdir(inputDir, { recursive: true });
      const managedAudioPaths = [];
      for (const [index, source] of audioPaths.entries()) {
        const target = path.join(inputDir, `${String(index + 1).padStart(3, '0')}-${path.basename(source)}`);
        await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
        for (const suffix of ['.txt', '.vtt', '.srt']) {
          const sidecar = [source + suffix, source.slice(0, -path.extname(source).length) + suffix].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
          if (sidecar) await fs.promises.copyFile(sidecar, target + suffix, fs.constants.COPYFILE_EXCL);
        }
        managedAudioPaths.push(target);
      }
      const project = {
        id,
        name: String(body.name || id).trim().slice(0, 100) || id,
        speaker: String(body.speaker || id).trim().slice(0, 100) || id,
        sourceLanguage: language,
        audioPaths: managedAudioPaths,
        originalAudioPaths: audioPaths, // Provenance only; never used as training inputs.
        createdAt: new Date().toISOString()
      };
      atomicWriteJson(projectFile, project);
      atomicWriteJson(path.join(projectDir, 'status.json'), { stage: 'new', message: `已导入 ${audioPaths.length} 个音频，等待预处理`, progress: 0, updatedAt: new Date().toISOString() });
      sendJson(res, { ok: true, project: projectSnapshot(id) }, 201);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/training/prepare') {
      const body = await readBody(req);
      const job = await launchTraining('prepare', body.projectId);
      sendJson(res, { ok: true, job }, 202);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/training/train') {
      const body = await readBody(req);
      const id = validateProjectId(body.projectId);
      if (!fs.existsSync(path.join(projectsDir, id, 'review.csv'))) throw new Error('请先完成预处理并审核 review.csv');
      const job = await launchTraining('train', id);
      sendJson(res, { ok: true, job }, 202);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/training/cancel') {
      const body = await readBody(req);
      const id = validateProjectId(body.projectId);
      if (!trainingJob || trainingJob.projectId !== id) throw new Error(`项目 ${id} 当前没有运行中的任务`);
      sendJson(res, { ok: true, job: cancelTraining() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/profiles') {
      sendJson(res, { ok: true, activeProfileId, profiles: loadProfiles().filter((p) => p.enabled !== false).map(publicProfile) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/select') {
      const body = await readBody(req);
      const profile = await enqueue(() => selectProfile(String(body.profileId || '')));
      sendJson(res, { ok: true, activeProfileId, profile: publicProfile(profile) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/synthesize') {
      const body = await readBody(req);
      const result = await enqueue(() => synthesize(body));
      sendJson(res, { ok: true, ...result });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice('/audio/'.length)));
      if (!/^[a-zA-Z0-9._-]+\.wav$/.test(name)) { sendJson(res, { ok: false, error: '文件名无效' }, 400); return; }
      const file = path.join(generatedDir, name);
      if (!fs.existsSync(file)) { sendJson(res, { ok: false, error: '音频不存在或已清理' }, 404); return; }
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=3600', 'content-length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return;
    }
    sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (error) {
    lastError = error?.message || String(error);
    log(`请求失败 ${req.method} ${url.pathname}: ${lastError}`);
    sendJson(res, { ok: false, error: lastError }, 500);
  }
});

cleanupGenerated();
setInterval(cleanupGenerated, 3600000).unref();
server.listen(Number(serviceConfig.port) || 9881, serviceConfig.host || '127.0.0.1', () => {
  log(`voice-service 已监听 http://${serviceConfig.host}:${serviceConfig.port}`);
  if (serviceConfig.autoStartGptApi !== false) ensureGptApi().catch((error) => { lastError = error.message; log(error.message); });
});

function shutdown() {
  server.close();
  if (gptApiChild && !gptApiChild.killed) gptApiChild.kill();
  if (trainingChild && !trainingChild.killed) cancelTraining();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
import {projectPath} from "../deployment/paths.mjs";

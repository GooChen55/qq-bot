import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Debate } from './debate.js';
import { DebateRunner } from './debate-runner.js';
import { DebateSender } from './debate-sender.js';
import { recommendDebateTopics } from './debate-research.js';
import { DebateSettings, validateDebateSettings } from './debate-settings.js';
import { NodeApiClient } from './dsh-client.js';

const ROOT = projectPath("debate");
const STATE = projectPath('debate/state');
const PORT = Number(process.env.DEBATE_HUB_PORT || 3010);
// 编排归 bot2；模型推理复用机队共享 DSH，避免重复占用模型会话与内存。
const DSH_URL = process.env.DEBATE_DSH_URL || 'http://127.0.0.1:2980';
const CHANNELS = projectPath("shared/debate-channels.json");
const ADMINS = projectPath("bot2-admins.json");
fs.mkdirSync(STATE, { recursive: true });

const tokenFile = path.join(STATE, 'console-token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'), 'utf8');
const consoleToken = fs.readFileSync(tokenFile, 'utf8').trim();
const commandLog = path.join(STATE, 'logs', 'commands.log');
fs.mkdirSync(path.dirname(commandLog), { recursive: true });
function audit(message) {
  const line = `${new Date().toISOString()} ${String(message).replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`;
  fs.appendFileSync(commandLog, line, 'utf8');
  console.log(`[debate-audit] ${line.trimEnd()}`);
}
const debate = new Debate(path.join(STATE, 'debate.json'));
const settings = new DebateSettings(path.join(STATE, 'debate-settings.json'));
const sender = new DebateSender((...args) => console.log('[debate]', ...args));
const runner = new DebateRunner(debate, new NodeApiClient(DSH_URL, { tokenFile: projectPath("bot5/state/dsh-token") }), (key, msg, botId) => sender.send(key, msg, botId), STATE,
  (...args) => console.error('[debate]', ...args));
const seen = new Map();

function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } }
function ownerOpenIds() { return new Set((json(ADMINS).openIds || []).map(String)); }
function robotQqs() { return new Set((json(projectPath("bots.json")).fleet || []).map((b) => b.accountQq).filter(Boolean).map(String)); }
function numericGroup(target) {
  if (/^\d+$/.test(String(target || ''))) return String(target);
  const groups = json(CHANNELS).groups || {};
  for (const [number, routes] of Object.entries(groups)) if (routes?.bot2 === target) return number;
  return null;
}
function cleanText(value) { return String(value || '').replace(/<@!?[^>]+>/g, '').trim(); }
function dedupeKey(input) { return `${input.groupId}|${input.userId}|${cleanText(input.text)}|${Math.floor(Date.now() / 5000)}`; }
function markSeen(input) {
  const now = Date.now();
  for (const [key, at] of seen) if (now - at > 15000) seen.delete(key);
  const key = dedupeKey(input);
  if (seen.has(key)) return false;
  seen.set(key, now); return true;
}
export async function handleCommand(input) {
  const text = cleanText(input.text);
  const match = /^\/(?:辩论|圆桌|roundtable)(?:\s+([\s\S]+))?$/i.exec(text);
  if (!match) return { handled: false };
  // 非 bot2 的控制转发静默忽略；不占用去重窗口，也不向群里发送重定向提示。
  if (input.sourceBot !== 'bot2') return { handled: true, ignored: true };
  const group = numericGroup(input.groupId || input.targetId);
  if (!group) throw new Error('当前官方群尚未绑定数字群号，不能建立辩论会话');
  if (!markSeen({ ...input, groupId: group, text })) { audit(`duplicate source=${input.sourceBot || '?'} group=${group} user=${input.userId || '?'} text=${text}`); return { handled: true, duplicate: true }; }
  audit(`accepted source=${input.sourceBot || '?'} group=${group} user=${input.userId || '?'} text=${text}`);
  const reply = (message, botId = 'bot2') => sender.send(`group:${group}`, message, botId, botId === 'bot2'
    ? { targetId: String(input.targetId || ''), msgId: String(input.eventId || '') }
    : null);
  const arg = String(match[1] || '').trim();
  const senderIsRobot = robotQqs().has(String(input.userId || ''));
  const isOwner = input.isOwner === true || ownerOpenIds().has(String(input.userId || ''));
  if (!arg || arg === '帮助' || /^help$/i.test(arg)) {
    await reply('辩论用法：/辩论 推荐时事；/辩论 选 1；/辩论 开始 辩题；/辩论 状态；/辩论 提问 问题；/辩论 辩驳 正方|反方 观点；/辩论 投票 正方|反方；/辩论 评出胜者；/辩论 继续；/辩论 结束。主持与阵容可在 QQBot 控制面板设置。');
    return { handled: true };
  }
  if (arg === '状态' || /^status$/i.test(arg)) { await reply(debate.status(group)); return { handled: true }; }
  const vote = /^投票\s+(正方|反方)$/.exec(arg);
  if (vote) { if (!senderIsRobot) await reply(debate.vote(group, input.userId, vote[1])); return { handled: true }; }
  const question = /^提问\s+([\s\S]+)$/.exec(arg);
  if (question) { if (!senderIsRobot) await reply(debate.question(group, input.userId, question[1])); return { handled: true }; }
  const rebuttal = /^辩驳\s+(正方|反方)\s+([\s\S]+)$/.exec(arg);
  if (rebuttal) { if (!senderIsRobot) await reply(debate.humanRebuttal(group, input.userId, rebuttal[1], rebuttal[2])); return { handled: true }; }
  if (!isOwner) { await reply('只有管理员能开启、继续或结束辩论；群友可在对应时段提问、辩驳或投票。'); return { handled: true }; }
  if (/^(?:评出胜者|评判|裁决|结束投票(?:[，,、\s]+由你)?评定(?:出)?获胜者)$/.test(arg)) {
    const item = debate.active(group);
    if (!item) { await reply('当前没有进行中的辩论。'); return { handled: true }; }
    const verdict = await runner.judge(item);
    const result = debate.finish(group, '主持人提前结束投票');
    await reply(`${result}\n【AI 裁判】${verdict}`);
    return { handled: true };
  }
  if (arg === '结束' || /^end$/i.test(arg)) { await reply(debate.finish(group, '主持人结束') || '当前没有进行中的辩论。'); return { handled: true }; }
  if (arg === '继续') {
    const item = debate.active(group);
    if (!item || item.stage !== 'interrupted') await reply('当前没有可继续的中断辩论。');
    else { debate.update(group, item.id, { stage: item.resumeStage || 'research' }); await reply('正在从中断阶段继续，已完成回合不会重写。'); void runner.run(group); }
    return { handled: true };
  }
  if (arg === '推荐时事') {
    try {
      const options = await recommendDebateTopics();
      if (!options.length) throw new Error('暂未找到可用候选');
      debate.setRecommendations(group, options);
      await reply(`候选新闻标题：\n${options.map((o) => `${o.number}. ${o.motion}\n${o.published} ${o.url}`).join('\n')}\n管理员使用 /辩论 选 1。`);
    } catch (error) {
      const cached = debate.cachedRecommendations(group);
      await reply(cached.length ? `实时新闻源暂时不可用，使用最近缓存：\n${cached.map((o, i) => `${i + 1}. ${o.motion}\n${o.published} ${o.url}`).join('\n')}\n使用 /辩论 选 1。` : `推荐时事失败：${error?.message || error}。也可以直接用 /辩论 开始 你的辩题。`);
    }
    return { handled: true };
  }
  const selection = /^选\s*([123])$/.exec(arg);
  if (!selection && !/^开始\s+\S/.test(arg)) {
    await reply('命令格式不正确。开启请使用：@bot2 /辩论 开始 <辩题>；查看用法：@bot2 /辩论 帮助。');
    return { handled: true };
  }
  const chosen = selection ? debate.getRecommendation(group, Number(selection[1])) : null;
  if (selection && !chosen) { await reply('候选已过期或不存在，请重新 /辩论 推荐时事。'); return { handled: true }; }
  try {
    const inputText = chosen ? chosen.motion : arg.replace(/^开始\s+/, '');
    const [topic, ...overrides] = inputText.split('|').map((v) => v.trim());
    const { bots, config } = settings.current();
    const selected = { ...config, proBots: [...config.proBots], contraBots: [...config.contraBots] };
    for (const option of overrides) {
      const override = /^(主持|正方|反方)\s*=\s*(bot\d+(?:\s*[,，]\s*bot\d+)*)$/i.exec(option);
      if (!override) throw new Error(`阵容参数格式错误：${option}`);
      const ids = override[2].toLowerCase().split(/\s*[,，]\s*/);
      if (override[1] === '主持') { if (ids.length !== 1) throw new Error('主持人只能指定一位'); selected.host = ids[0]; }
      else if (override[1] === '正方') selected.proBots = ids; else selected.contraBots = ids;
    }
    const valid = validateDebateSettings(selected, bots);
    const started = debate.start(group, input.userId, topic, valid);
    if (started.ok && chosen) debate.update(group, started.item.id, { seedUrl: chosen.url, seedTitle: chosen.title, seedPublished: chosen.published, seedExcerpt: chosen.excerpt });
    await reply(started.message);
    if (started.ok) void runner.run(group, { currentEvents: Boolean(chosen) });
  } catch (error) { await reply(`无法开赛：${error?.message || error}`); }
  return { handled: true };
}

async function body(req) { const chunks=[]; for await (const c of req) { chunks.push(c); if (chunks.reduce((n,x)=>n+x.length,0)>65536) throw new Error('请求过大'); } return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
function send(res, status, payload) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok:true, owner:'bot2', port:PORT, dsh:DSH_URL });
    if (url.pathname === '/api/command' && req.method === 'POST') return send(res, 200, { ok:true, ...(await handleCommand(await body(req))) });
    if (url.pathname === '/api/config') {
      if (req.headers['x-console-token'] !== consoleToken) return send(res, 401, { ok:false, error:'访问令牌无效' });
      if (req.method === 'GET') return send(res, 200, { ok:true, ...settings.current() });
      if (req.method === 'POST') return send(res, 200, { ok:true, ...settings.update(await body(req)) });
    }
    send(res, 404, { ok:false, error:'not found' });
  } catch (error) {
    audit(`error method=${req.method} url=${req.url} message=${error?.stack || error?.message || String(error)}`);
    send(res, 400, { ok:false, error:error?.message || String(error) });
  }
});
for (const [group, item] of Object.entries(debate.state.active)) if (['research','opening','rebuttal'].includes(item.stage)) debate.update(group, item.id, { stage:'interrupted', resumeStage:item.stage });
setInterval(() => void runner.tick(), 5000).unref();
server.listen(PORT, '127.0.0.1', () => console.log(`[debate-hub] bot2 owner listening on 127.0.0.1:${PORT}; DSH=${DSH_URL}`));
import {projectPath} from "../../deployment/paths.mjs";

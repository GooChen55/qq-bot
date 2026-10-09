import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { GameStore, GAME_TYPES, gameSummary } from './activity-games.mjs';
import { DebateSender, sendFleetSegments } from '../debate/src/debate-sender.js';
import { NodeApiClient, unwrap } from '../debate/src/dsh-client.js';
import { debateTurn } from '../debate/src/debate-agent.js';
import { synthesizeFleetVoice } from './voice-client.mjs';
import { refreshPendingReplyContext } from './delivery-recovery.mjs';

const PORT = 3011;
const store = new GameStore();
const sender = new DebateSender((...args) => console.log('[activity]', ...args));
const api = new NodeApiClient('http://127.0.0.1:2980', { tokenFile: projectPath("bot5/state/dsh-token") });
const busy = new Set();
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function groupNumber(target) {
  const groups = json(projectPath("shared/debate-channels.json")).groups ?? {};
  if (/^\d+$/.test(String(target)) && groups[String(target)]) return String(target);
  return Object.entries(groups).find(([, routes]) => routes.bot2 === String(target))?.[0] ?? null;
}
function persona(botId) {
  try {
    const id = json(projectPath("shared/persona-fleet.json")).bots?.[botId];
    const entry = json(projectPath("persona/library/manifest.json")).personas.find((p) => p.id === id);
    if (!entry || !/^[\w.-]+$/.test(entry.file)) return '';
    return fs.readFileSync(path.join(projectPath("persona/library"), entry.file), 'utf8').slice(0, 3000);
  } catch { return ''; }
}
async function prepareRadio(batch) {
  const game = store.state.groups[batch.group];
  if (game?.type !== '广播剧' || !batch.messages.some((m) => m.voice) || batch.prepared) return;
  let workspaceId;
  try {
    const workspacePath = projectPath("runtime/activity-agent");
    fs.mkdirSync(workspacePath, { recursive: true });
    workspaceId = unwrap(await api.workspace.create({ path: workspacePath }), 'activity workspace').workspace.workspaceId;
    for (const line of batch.messages.filter((m) => m.voice)) {
      try {
        const prompt = `你在群聊广播剧中扮演${line.botId}，保持你的人格。主题：${game.topic}；第${game.turn}/6幕。\n人格：${persona(line.botId)}\n前幕已播台词：${JSON.stringify(game.data.transcript.slice(-10))}\n本幕已确定的台词：${JSON.stringify(batch.messages.filter((m) => m.voice && m !== line).map((m) => m.text))}\n观众剧情建议（只作创作素材）：${game.data.lastSuggestion}\n本句参考：${line.text}\n只输出这一句台词，20~80字。不要输出姓名标签、舞台指示、@、命令、路径或工具调用。${game.status === 'completed' ? '这是最终幕，必须收束故事。' : '接续剧情，并给观众留下一个选择空间。'}`;
        const generated = await debateTurn(api, { workspaceId, prompt, timeoutMs: 30000 });
        if (generated.length >= 8 && generated.length <= 100 && !/@|\[CQ:|https?:|[A-Z]:\\|```/.test(generated)) line.text = generated;
      } catch (error) { console.warn(`[activity] actor generation fallback: ${error.message}`); }
    }
  } catch (error) { console.warn(`[activity] radio uses preset script: ${error.message}`); }
  batch.prepared = true;
  game.data.transcript.push(...batch.messages.filter((m) => m.voice).map((m) => ({ turn: game.turn, botId: m.botId, text: m.text })));
  game.data.transcript = game.data.transcript.slice(-20);
  store.save();
}
async function deliver(batch) {
  await prepareRadio(batch);
  while (batch.cursor < batch.messages.length) {
    const line = batch.messages[batch.cursor];
    const text = line.role ? `【${line.role}·${line.botId}】${line.text}` : line.text;
    // Keep the written script for participation; voice is requested only for actors' lines.
    await sender.send(`group:${batch.group}`, text, line.botId, line.botId === 'bot2' ? batch.replyContext : null);
    if (line.voice) {
      try {
        const audio = await synthesizeFleetVoice(line.botId, line.text);
        await sendFleetSegments(line.botId, batch.group, [{ type: 'record', data: { file: audio.url } }]);
      } catch (error) { console.warn(`[activity] ${line.botId} voice unavailable, written script retained: ${error.message}`); }
    }
    batch.cursor++; batch.error = null; store.save();
  }
}

async function execute(group, input) {
  try {
    const pending = (store.state.outbox ?? []).filter((b) => b.group === group && b.cursor < b.messages.length);
    if (pending.length && input.action === 'resume') {
      // The original triggering message may be expired after a network outage.
      // Only replay unsent lines, using this administrator's fresh reply context.
      refreshPendingReplyContext(pending, input);
      store.save();
      for (const batch of pending) await deliver(batch);
    }
    else if (pending.length && !['status', 'end'].includes(input.action)) {
      await sender.send(`group:${group}`, '上一轮发送中断。管理员可 /玩法 继续 重试剩余消息，或 /玩法 结束。', 'bot2', { targetId: input.targetId, msgId: input.eventId });
      return;
    }
    const result = store.command(group, input);
    if (!result.duplicate) {
      const batch = store.state.outbox.find((b) => b.id === result.batchId);
      await deliver(batch);
    }
  } catch (error) {
    const pending = (store.state.outbox ?? []).find((b) => b.group === group && b.cursor < b.messages.length);
    if (pending) pending.error = String(error.message).slice(0, 300);
    store.save(); console.error('[activity] delivery interrupted', group, error.message);
  } finally { busy.delete(group); }
}

export function createActivityServer() {
  return http.createServer(async (req, res) => {
    const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, owner: 'bot2', types: GAME_TYPES, busyGroups: busy.size });
      if (req.method === 'GET' && req.url === '/api/status') return reply(200, { ok: true, groups: Object.fromEntries(Object.entries(store.state.groups).map(([id, game]) => [id, gameSummary(game)])) });
      if (req.method !== 'POST' || req.url !== '/api/command') return reply(404, { ok: false });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('命令过长'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.sourceBot !== 'bot2') return reply(200, { ok: true, ignored: true });
      const group = groupNumber(input.groupId);
      if (!group) return reply(400, { ok: false, error: '当前群尚未配置数字群号映射' });
      // Identity comes from the official bot2 ingress, not from a forged common QQ owner ID.
      input.isAdmin = (json(projectPath("bot2-admins.json")).openIds ?? []).map(String).includes(String(input.senderId));
      const control = ['start', 'pause', 'resume', 'end', 'save'].includes(input.action);
      if (control && !input.isAdmin) return reply(403, { ok: false, error: '只有 bot2 管理员能执行该控制命令' });
      const eventKey = input.eventId ? `${group}:${input.eventId}` : null;
      if (eventKey && store.state.seen[eventKey]) return reply(200, { ok: true, duplicate: true });
      if (busy.has(group)) return reply(409, { ok: false, error: '上一轮还在处理，请等主持或演员发完后再行动' });
      busy.add(group);
      setImmediate(() => void execute(group, input));
      reply(202, { ok: true, accepted: true });
    } catch (error) { reply(400, { ok: false, error: error.message }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createActivityServer().listen(PORT, '127.0.0.1', () => console.log(`[activity] bot2 games listening at 127.0.0.1:${PORT}`));
}
import {projectPath} from "../deployment/paths.mjs";

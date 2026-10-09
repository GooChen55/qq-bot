import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.QQBOT_SHARED_ROOT || projectPath("runtime");
const STATE_FILE = path.join(ROOT, 'group-coordinator.json');
const LOCK_FILE = path.join(ROOT, 'group-coordinator.lock');
const VERSION = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLock(fn) {
  await fs.mkdir(ROOT, { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      handle = await fs.open(LOCK_FILE, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 10000) await fs.unlink(LOCK_FILE);
      } catch {}
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  if (!handle) throw new Error('群聊协调器锁等待超时');
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(LOCK_FILE).catch(() => {});
  }
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: VERSION, groups: {} };
  } catch {
    return { version: VERSION, groups: {} };
  }
}

async function writeState(state) {
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, STATE_FILE);
}

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

export function classifyGroupIntent(text) {
  const value = cleanText(text).toLowerCase();
  if (/(搜|查|找图|看图|识图|生成图|画图|文件|链接|视频|音频|语音|天气|新闻|资料)/i.test(value)) return 'tool';
  if (/[?？]$/.test(value) || /^(什么|为什么|怎么|如何|是否|谁|哪|几|多少|能不能|可不可以)/i.test(value)) return 'fact';
  if (/(哈哈|笑死|离谱|绷不住|好家伙|牛|草|6+|啊这|确实|绝了|乐|贴贴)/i.test(value)) return 'social';
  return 'chat';
}

function priorityFor(role, intent, mentioned) {
  if (mentioned) return 100;
  if (role === 'tool') return intent === 'tool' ? 70 : 5;
  if (role === 'answer') return intent === 'fact' ? 65 : 10;
  if (role === 'main') return intent === 'social' ? 55 : 60;
  if (role === 'vibe') return intent === 'social' ? 40 : 20;
  return 10;
}

export async function claimGroupTurn(input = {}) {
  const groupId = cleanText(input.groupId, 40);
  const botId = cleanText(input.botId, 80);
  const eventId = cleanText(input.eventId || `${input.userId || 'unknown'}:${cleanText(input.text, 120)}`, 180);
  if (!groupId || !botId) return { granted: false, reason: 'missing-identity' };
  const now = Date.now();
  const intent = input.intent || classifyGroupIntent(input.text);
  const priority = priorityFor(input.role || 'main', intent, input.mentioned === true);
  if (input.targetedOtherBot === true) return { granted: false, reason: 'targeted-other-bot', intent, priority };
  if (input.senderIsBot === true && input.allowBotHandoff !== true) return { granted: false, reason: 'bot-message', intent, priority };

  return withLock(async () => {
    const state = await readState();
    state.version = VERSION;
    state.groups ||= {};
    const group = state.groups[groupId] ||= { memory: [], history: [] };
    const current = group.lease;
    if (current && current.expiresAt > now && current.eventId === eventId && current.botId !== botId && current.priority >= priority) {
      return { granted: false, reason: 'leased', holder: current.botId, intent, priority, expiresAt: current.expiresAt };
    }
    group.lease = {
      botId,
      role: cleanText(input.role || 'main', 30),
      eventId,
      intent,
      priority,
      claimedAt: now,
      expiresAt: now + Math.max(5000, Math.min(120000, Number(input.leaseMs) || 30000))
    };
    group.history = Array.isArray(group.history) ? group.history.filter((x) => now - Number(x?.time || 0) < 86400000).slice(-39) : [];
    group.history.push({ time: now, eventId, botId, role: input.role || 'main', intent, action: 'claim' });
    await writeState(state);
    return { granted: true, intent, priority, lease: group.lease };
  });
}

export async function noteGroupSent(input = {}) {
  const groupId = cleanText(input.groupId, 40);
  const botId = cleanText(input.botId, 80);
  if (!groupId || !botId) return;
  const now = Date.now();
  return withLock(async () => {
    const state = await readState();
    state.groups ||= {};
    const group = state.groups[groupId] ||= { memory: [], history: [] };
    group.lease = {
      ...(group.lease || {}),
      botId,
      eventId: cleanText(input.eventId || group.lease?.eventId || '', 180),
      sentAt: now,
      expiresAt: now + Math.max(3000, Math.min(60000, Number(input.cooldownMs) || 12000))
    };
    group.history = Array.isArray(group.history) ? group.history.slice(-39) : [];
    group.history.push({ time: now, botId, action: 'sent' });
    await writeState(state);
  });
}

export async function rememberGroupFact(groupId, fact = {}) {
  const id = cleanText(groupId, 40);
  const text = cleanText(fact.text || fact.content, 240);
  if (!id || !text) return;
  return withLock(async () => {
    const state = await readState();
    state.groups ||= {};
    const group = state.groups[id] ||= { memory: [], history: [] };
    group.memory = Array.isArray(group.memory) ? group.memory : [];
    const category = cleanText(fact.category || 'fact', 40);
    const target = cleanText(fact.target || '', 80);
    const same = group.memory.find((x) => x.category === category && x.target === target && x.text === text);
    if (same) same.updatedAt = Date.now();
    else group.memory.push({ category, target, text, updatedAt: Date.now(), source: cleanText(fact.source || 'qqbridge', 40) });
    group.memory = group.memory.slice(-80);
    await writeState(state);
  });
}

export async function getGroupMemory(groupId, limit = 12) {
  const state = await readState();
  const items = state.groups?.[cleanText(groupId, 40)]?.memory;
  if (!Array.isArray(items)) return [];
  return items.slice(-Math.max(1, Math.min(30, Number(limit) || 12)));
}
import {projectPath} from "../deployment/paths.mjs";

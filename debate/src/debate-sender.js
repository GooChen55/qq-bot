import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { retryConnectFailure } from '../../shared/delivery-recovery.mjs';

const FLEET_FILE = projectPath("bots.json");
const CHANNEL_FILE = projectPath("shared/debate-channels.json");
const RELAY_DIR = projectPath("shared/debate-relay");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function member(botId) { return json(FLEET_FILE).fleet.find((entry) => entry.id === botId) ?? null; }
function oneBotToken(bot) {
  const cfg = json(path.join(bot.napcat.workDir, 'config', `onebot11_${bot.accountQq}.json`));
  return cfg.network?.websocketServers?.find((entry) => entry.enable && Number(entry.port) === Number(bot.ports.onebotWs))?.token ?? '';
}

async function sendOneBot(bot, groupId, message) {
  const port = Number(bot.ports?.onebotWs);
  if (!port) throw new Error(`${bot.id} 未登记 OneBot WebSocket 端口`);
  const url = `ws://127.0.0.1:${port}/?access_token=${encodeURIComponent(oneBotToken(bot))}`;
  const echo = `debate-${crypto.randomUUID()}`;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${bot.id} 发送超时`)), 7000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ action: 'send_group_msg', echo,
      params: { group_id: Number(groupId), message: Array.isArray(message) ? message : [{ type: 'text', data: { text: message } }] } })));
    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.echo !== echo) return;
        finish(Number(data.retcode) === 0 ? null : new Error(data.message || data.wording || `${bot.id} OneBot retcode=${data.retcode}`));
      } catch { /* event frame */ }
    });
    socket.addEventListener('error', () => finish(new Error(`${bot.id} OneBot 连接失败`)));
  });
}

async function relayOfficial(botId, groupId, message, replyContext = null) {
  const target = replyContext?.targetId || json(CHANNEL_FILE).groups?.[String(groupId)]?.[botId];
  if (!target) throw new Error(`${botId} 尚未绑定当前群的官方 group_openid`);
  const jobs = path.join(RELAY_DIR, 'jobs');
  const acks = path.join(RELAY_DIR, 'acks');
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(acks, { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const temp = path.join(jobs, `${id}.tmp`);
  const final = path.join(jobs, `${id}.json`);
  fs.writeFileSync(temp, JSON.stringify({ id, botId, scope: 'group', targetId: target,
    msgId: replyContext?.msgId || undefined,
    message: String(message).slice(0, 1800), createdAt: Date.now() }), 'utf8');
  fs.renameSync(temp, final);
  const ackFile = path.join(acks, `${id}.json`);
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (fs.existsSync(ackFile)) {
      const ack = json(ackFile);
      try { fs.unlinkSync(ackFile); } catch {}
      if (ack.ok) return;
      throw new Error(ack.error || `${botId} 官方通道发送失败`);
    }
    await sleep(150);
  }
  throw new Error(`${botId} 官方通道未确认发送`);
}

export class DebateSender {
  constructor(log = () => {}) { this.log = log; }
  async send(key, message, botId = null, replyContext = null) {
    const match = /^group:(\d+)$/.exec(String(key));
    if (!match) throw new Error(`不支持的辩论目标：${key}`);
    const selectedBot = botId || 'bot2';
    try {
      const bot = member(selectedBot);
      if (!bot) throw new Error(`${selectedBot} 不在机队登记表中`);
      if (bot.kind === 'official-qqbot') await retryConnectFailure(() => relayOfficial(selectedBot, match[1], message, replyContext), { log: this.log });
      else if (bot.kind === 'onebot-napcat') await sendOneBot(bot, match[1], message);
      else if (bot.kind === 'external-bridge') await sendOneBot(bot, match[1], message);
      else throw new Error(`${selectedBot} 没有可用的独立发送通道`);
      this.log(`辩论消息已由 ${selectedBot} 自己发送到 ${key}`);
    } catch (error) {
      if (selectedBot === 'bot2') throw error;
      this.log(`${selectedBot} 通道不可用，改由主持 bot2 代发：${error?.message ?? error}`);
      await relayOfficial('bot2', match[1], `【${selectedBot} 通道暂不可用，主持代发】${message}`);
    }
  }
}

// Shared activity sender: send an explicit record segment using the selected bot's own account.
export async function sendFleetSegments(botId, groupId, segments) {
  const bot = member(botId);
  if (!bot || !['onebot-napcat', 'external-bridge'].includes(bot.kind)) throw new Error(`${botId} 没有 OneBot 语音通道`);
  return sendOneBot(bot, groupId, segments);
}
import {projectPath} from "../../deployment/paths.mjs";

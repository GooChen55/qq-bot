import fs from 'node:fs';
import path from 'node:path';
import { GAME_FILE, GAME_TYPES, gameHelp } from './activity-games.mjs';

const STATE_FILE = projectPath("runtime/activity-state.json");
const VERSION = 1;
const TYPES = new Map([
  ['猜角色', { title: '动漫角色猜猜看', instruction: '主持一轮动漫角色猜谜。你在心里选一个符合主题的角色，但绝对不要直接说答案。先给三个由泛到具体的线索，并说明群友单独 @bot2 后发送猜测，最多再请求两次提示。回复应像群主持，简短清楚。' }],
  ['次元场景', { title: '次元聊天室', instruction: '根据主题建立一个10分钟的动漫角色聊天室。先说明地点、登场角色和本场目标，再给群友一个能直接参与的开场事件。不要替群友作决定。' }],
  ['穿越', { title: '动漫世界穿越', instruction: '根据指定作品或主题生成一次独立的短篇穿越副本。开场只交代环境、当前危机和三个行动选项，不提前写结局。' }],
  ['盲盒', { title: '动漫盲盒', instruction: '主持一次免费的动漫盲盒活动。说明本轮主题和领取方式，先展示一个示例奖励；奖励只能是虚拟称号、台词、剧情支线或纪念卡，不涉及付费和交易。' }],
  ['祭典', { title: '次元祭典', instruction: '开启一个10分钟的二次元节日活动。说明场景、两个小游戏和参与口令，让群友可以马上加入。内容保持跨作品兼容。' }],
  ['辩论', { title: '圆桌议会', instruction: '主持一场限时圆桌。宣布议题，并依次邀请 bot2 给出事实与理由、bot4 从角色视角表达、bot3 核查一个具体问题。明确说明每次只单独 @ 一个机器人，禁止同时 @ 多个机器人，最后由群友投票。' }],
]);

function normalize(text) {
  return String(text ?? '')
    .replace(/\[CQ:at,[^\]]+\]/gi, ' ')
    .replace(/<@!?[^>]+>/g, ' ')
    .replace(/^\s*(?:@\S+\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseActivityCommand(text) {
  const value = normalize(text);
  let match = /^\/(玩法)(?:\s+(.+))?$/u.exec(value);
  if (match) {
    const arg = String(match[2] ?? '').trim();
    if (!arg || /^(帮助|列表|help)$/i.test(arg)) return { action: 'help', raw: value };
    if (/^(状态|status)$/i.test(arg)) return { action: 'status', raw: value };
    if (/^(结束|停止|end|stop)$/i.test(arg)) return { action: 'end', raw: value };
    if (arg === '暂停') return { action: 'pause', raw: value };
    if (arg === '继续') return { action: 'resume', raw: value };
    if (arg === '存档') return { action: 'save', raw: value };
    const act = /^行动\s+(.+)$/u.exec(arg);
    if (act) return { action: 'act', content: act[1], raw: value };
    const start = /^(?:开启|开始|start)\s+(猜角色|次元场景|穿越|盲盒|祭典|辩论|侦探|经营|广播剧|海龟汤|知识擂台|合作冒险)(?:\s+(.+))?$/iu.exec(arg);
    if (!start) return { action: 'invalid', raw: value };
    return { action: 'start', type: start[1], topic: String(start[2] ?? '').trim(), raw: value };
  }
  match = /^\/(辩论|圆桌|roundtable)(?:\s+(.+))?$/iu.exec(value);
  if (match) {
    const arg = String(match[2] ?? '').trim();
    return { action: 'debate', command: `/辩论${arg ? ` ${arg}` : ''}`, raw: value };
  }
  match = /^\/(猜角色|次元场景|穿越|盲盒|祭典)(?:\s+(.+))?$/u.exec(value);
  if (!match) return null;
  return { action: 'start', type: match[1], topic: String(match[2] ?? '').trim(), raw: value };
}

export function isActivityCommand(text) { return parseActivityCommand(text) !== null; }

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (state?.version === VERSION && state.groups && typeof state.groups === 'object') return state;
  } catch {}
  return { version: VERSION, groups: {} };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, STATE_FILE);
}

async function forwardDebateCommand(groupOpenid, command, senderId, isAdmin, eventId) {
  const response = await fetch('http://127.0.0.1:3010/api/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceBot: 'bot2', groupId: String(groupOpenid), targetId: String(groupOpenid),
      userId: String(senderId ?? ''), isOwner: isAdmin === true,
      text: command, eventId: String(eventId ?? ''),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(body.error || `玩法服务返回 HTTP ${response.status}`);
  return body;
}
function currentGame(groupOpenid) {
  try {
    const groups = JSON.parse(fs.readFileSync(projectPath("shared/debate-channels.json"), 'utf8').replace(/^\uFEFF/, '')).groups;
    const number = /^\d+$/.test(String(groupOpenid)) ? String(groupOpenid)
      : Object.entries(groups).find(([, routes]) => routes.bot2 === String(groupOpenid))?.[0];
    return JSON.parse(fs.readFileSync(GAME_FILE, 'utf8').replace(/^\uFEFF/, '')).groups?.[number] ?? null;
  } catch { return null; }
}
export function isManagedActivityGroup(groupId) {
  const game = currentGame(groupId);
  return Boolean(game && ['active', 'paused'].includes(game.status));
}
async function forwardGameCommand(context, command) {
  try {
    const response = await fetch('http://127.0.0.1:3011/api/command', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...command, sourceBot: 'bot2', groupId: context.groupId,
        targetId: context.groupId, senderId: context.senderId, eventId: context.eventId }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
    return { consumed: true, response: null };
  } catch (error) { return { consumed: true, response: `玩法服务：${error.message}` }; }
}
export async function handleBot2ActivityCommand({ text, scope, groupId, senderId, isAdmin, eventId }) {
  const command = parseActivityCommand(text);
  const context = { groupId, senderId, eventId };
  const savedGame = scope === 'group' ? currentGame(groupId) : null;
  if (scope === 'group' && savedGame && !command && normalize(text) && !normalize(text).startsWith('/')) {
    return forwardGameCommand(context, { action: 'act', content: normalize(text) });
  }
  if (!command) {
    if (scope !== 'group' || !String(text ?? '').trim() || normalize(text).startsWith('/')) return null;
    const state = readState();
    const current = state.groups[String(groupId ?? '')];
    if (!current) return null;
    if (Date.now() - current.startedAt >= 10 * 60 * 1000) {
      delete state.groups[String(groupId ?? '')];
      writeState(state);
      return null;
    }
    return { consumed: false, agentPrompt: `【当前群玩法】主持 bot2；${current.title}；主题：${current.topic}。沿用本场历史中的设定和答案，回应下面这位群友的参与；不要重新开场，不要替群友行动，不要 @ 其他机器人。\n群友 ${String(senderId ?? '')}：${String(text)}` };
  }
  if (scope !== 'group') return { consumed: true, response: '玩法只能在群里由 bot2 开启。请在目标群 @bot2 后发送命令。' };
  const key = String(groupId ?? '');
  const state = readState();
  let current = state.groups[key] ?? null;
  if (current && Date.now() - current.startedAt >= 10 * 60 * 1000) {
    delete state.groups[key];
    writeState(state);
    current = null;
  }
  const help = '玩法入口（群里必须 @bot2，并在 @ 后留一个空格）：\n@bot2 /玩法 开启 猜角色 [主题]\n@bot2 /玩法 开启 次元场景 <作品或场景>\n@bot2 /玩法 开启 穿越 <作品>\n@bot2 /玩法 开启 盲盒 [主题]\n@bot2 /玩法 开启 祭典 <主题>\n@bot2 /辩论 开始 <议题>\n简写：/猜角色、/次元场景、/穿越、/盲盒、/祭典。\n控制：/玩法 状态、/玩法 结束；辩论使用 /辩论 状态、/辩论 结束。';
  if (command.action === 'help') return { consumed: true, response: `${help}\n\n${gameHelp}` };
  if (command.action === 'invalid') return { consumed: true, response: `命令格式不正确。\n${help}` };
  if (savedGame && command.action === 'start' && !GAME_TYPES.includes(command.type)) {
    return { consumed: true, response: '当前有进行中或已存档的玩法，请先 /玩法 结束。' };
  }
  if ((command.action === 'start' && GAME_TYPES.includes(command.type)) || (savedGame && ['status', 'pause', 'resume', 'end', 'save', 'act'].includes(command.action))) {
    if (current) return { consumed: true, response: '当前有另一场玩法，请先 /玩法 结束。' };
    return forwardGameCommand(context, command);
  }
  if (['pause', 'resume', 'save', 'act'].includes(command.action)) return { consumed: true, response: `请先开启存档玩法：${GAME_TYPES.join('、')}。旧版短玩法只支持状态和结束。` };
  if (command.action === 'debate' || (command.action === 'start' && command.type === '辩论')) {
    const forwarded = command.action === 'debate'
      ? command.command
      : `/辩论 开始 ${command.topic || '随机二次元议题'}`;
    if (savedGame && /^\/辩论\s+(开始|选|继续)(?:\s|$)/.test(forwarded)) {
      return { consumed: true, response: '当前有另一场玩法存档，请先 /玩法 结束 后再开启圆桌。' };
    }
    const privileged = /^(?:\/辩论)(?:\s+(?:开始|选|推荐时事|继续|结束)(?:\s|$))/i.test(forwarded);
    if (privileged && !isAdmin) return { consumed: true, response: '只有 bot2 管理员可以开启、继续、选择题目或结束辩论；群友可以提问、辩驳和投票。' };
    try {
      await forwardDebateCommand(groupId, forwarded, senderId, isAdmin, eventId);
      return { consumed: true, response: null };
    } catch (error) {
      return { consumed: true, response: `玩法引擎暂时不可用：${error?.message ?? error}` };
    }
  }
  if (command.action === 'status') {
    if (!current) return { consumed: true, response: '当前群没有进行中的玩法。' };
    return { consumed: true, response: `当前玩法：${current.title}\n主题：${current.topic || '随机'}\n主持：bot2\n开始时间：${new Date(current.startedAt).toLocaleString('zh-CN', { hour12: false })}` };
  }
  if (!isAdmin) return { consumed: true, response: '只有 bot2 管理员可以开启或结束玩法；群友可以参加已经开启的活动。' };
  if (command.action === 'end') {
    if (!current) return { consumed: true, response: '当前群没有进行中的玩法。' };
    delete state.groups[key];
    writeState(state);
    return { consumed: true, response: `「${current.title}」已结束。bot2 已释放主持状态，其他机器人恢复普通唤醒规则。` };
  }
  if (current) return { consumed: true, response: `当前已有「${current.title}」在进行。请先发送 /玩法 结束。` };
  const definition = TYPES.get(command.type);
  if (!definition) return { consumed: true, response: help };
  const topic = command.topic || '随机二次元主题';
  state.groups[key] = { type: command.type, title: definition.title, topic, host: 'bot2', owner: String(senderId ?? ''), startedAt: Date.now() };
  writeState(state);
  return {
    consumed: false,
    agentPrompt: `【后台玩法主持指令】\n你是本场唯一主持人 bot2。现在开启「${definition.title}」，主题是「${topic}」。\n${definition.instruction}\n硬规则：开场消息不能同时 @ 多个机器人；告诉群友需要某位机器人参与时一次只 @ 那一位。不要让机器人互相连续对话。玩法控制命令只归 bot2 处理。`
  };
}
import {projectPath} from "../deployment/paths.mjs";

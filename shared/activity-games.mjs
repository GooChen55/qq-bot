import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXTRA_GAME_TYPES, initializeExtraGame, extraSummary, extraOpening, advanceExtraGame } from './activity-extra-games.mjs';

export const GAME_TYPES = ['侦探', '经营', '广播剧', ...EXTRA_GAME_TYPES];
export const GAME_FILE = projectPath("runtime/group-games.json");
const CASES = [
  {
    title: '午夜失踪的手稿', culprit: '档案员',
    opening: '博物馆停电七分钟后，展柜里的航海手稿消失。没有人员离馆。请找出拿走手稿的人和证据。',
    clues: {
      展柜: '锁没有被撬；备用钥匙上午交给了档案员。',
      走廊: '走廊摄像头的备用电源仍在工作：停电时档案员推着文件车经过。',
      文件车: '车底夹层有一只装着手稿的防潮袋，袋口粘着档案室的绿色封签。',
    },
    witnesses: {
      保安: { botId: 'bot4', text: '停电时我一直守着出口。我看到档案员推车去西侧，但以为那是例行归档。' },
      档案员: { botId: 'bot5', text: '我确实拿过备用钥匙，也推过车，但我说的是整理资料。你们想指认我，得先拿出证据。' },
    },
    required: ['走廊', '文件车'],
    ending: '档案员承认想在手稿归库前私自拍摄并藏匿。文件车中的手稿和备用电源录像共同证明了经过。',
  },
  {
    title: '雨夜的失踪奖杯', culprit: '维修员',
    opening: '社团颁奖前，锁在活动室的奖杯失踪。大雨封住了出口，奖杯应该还在楼内。',
    clues: {
      活动室: '门锁完好。登记表显示只有社长和维修员借过钥匙。',
      楼梯: '湿脚印通向器材室，鞋底三角缺口与维修员的工作靴一致。',
      器材室: '工具箱内找到用维修布包住的奖杯，旁边有维修员签名的领用单。',
    },
    witnesses: {
      社长: { botId: 'bot4', text: '我借钥匙时奖杯还在，随后去了排练厅。可以检查排练签到表。' },
      维修员: { botId: 'bot5', text: '我去过活动室检修灯。我带走的只是工具箱，你们可以先查清楚。' },
    },
    required: ['楼梯', '器材室'],
    ending: '维修员承认误以为奖杯是待修道具，装进工具箱后没有登记。找到奖杯不等于发现恶意犯罪，本案是一次失误。',
  },
];

const host = (text) => ({ botId: 'bot2', text });
const actor = (botId, role, text, voice = false) => ({ botId, role, text, voice });
export const gameHelp = '存档玩法（必须单独 @bot2）：\n/玩法 开启 侦探 [午夜手稿|雨夜奖杯]\n/玩法 开启 经营 [店名或主题]\n/玩法 开启 广播剧 <主题>\n/玩法 开启 海龟汤 [末班车|生日蛋糕]\n/玩法 开启 知识擂台 [通识|动漫]\n/玩法 开启 合作冒险 [队伍名]\n/玩法 行动 <内容>\n/玩法 状态｜存档｜暂停｜继续｜结束\n侦探：搜证 <地点>、询问 <人物>、提示、指认 <人物>\n经营：采购 <1~10>、营业、升级、休息\n广播剧：下一幕 [建议]；最多6幕\n海龟汤：提问 <问题>、提示、解答 <推理>\n知识擂台：答案 A/B/C、提示；每人每题一次\n合作冒险：选择 A/B；共享资源，六章冒险。';

export function gameSummary(game) {
  if (!game) return '当前没有存档玩法。';
  let detail = extraSummary(game);
  if (game.type === '侦探') detail = `案件：${game.data.title}；公开线索：${game.data.found.join('、') || '无'}；提示 ${game.data.hints}/2`;
  if (game.type === '经营') detail = `第${game.data.day}天；资金 ${game.data.cash}；库存 ${game.data.stock}；等级 ${game.data.level}；口碑 ${game.data.reputation}`;
  if (game.type === '广播剧') detail = `已完成 ${game.turn}/6 幕；下一幕需群友主动推进；关键台词请求语音播放。`;
  return `「${game.title}」主题：${game.topic}\n状态：${game.status}；轮次 ${game.turn}/${game.maxTurns}\n${detail}`;
}

export function newGame(type, topic, owner, now = Date.now(), caseIndex = 0) {
  if (!GAME_TYPES.includes(type)) throw new Error('不支持的玩法');
  const game = { id: crypto.randomUUID(), type, title: { 侦探: '侦探事务所', 经营: '群聊经营', 广播剧: '语音广播剧', 海龟汤: '海龟汤推理', 知识擂台: '知识擂台', 合作冒险: '合作冒险' }[type],
    topic: String(topic || (type === '经营' ? '星光咖啡馆' : type === '广播剧' ? '雨夜车站的重逢' : '午夜手稿')).slice(0, 120),
    owner, status: 'active', turn: 0, maxTurns: type === '经营' ? 30 : type === '广播剧' ? 6 : 12, createdAt: now, updatedAt: now, data: {} };
  if (type === '侦探') {
    const selected = /雨夜|奖杯/.test(game.topic) ? 1 : caseIndex % CASES.length;
    game.data = { caseIndex: selected, title: CASES[selected].title, found: [], hints: 0 };
  }
  if (type === '经营') game.data = { day: 1, cash: 100, stock: 6, level: 1, reputation: 0 };
  if (type === '广播剧') game.data = { transcript: [] };
  if (EXTRA_GAME_TYPES.includes(type)) {
    if (!topic) game.topic = { 海龟汤: '末班车', 知识擂台: '通识', 合作冒险: '雾山送信队' }[type];
    game.maxTurns = { 海龟汤: 20, 知识擂台: 5, 合作冒险: 6 }[type];
    initializeExtraGame(game);
  }
  return game;
}

export function gameOpening(game) {
  if (EXTRA_GAME_TYPES.includes(game.type)) return extraOpening(game);
  if (game.type === '侦探') {
    const c = CASES[game.data.caseIndex];
    return [host(`【侦探事务所】${c.title}\n${c.opening}\n可搜证：${Object.keys(c.clues).join('、')}；可询问：${Object.keys(c.witnesses).join('、')}。\n单独 @bot2 /玩法 行动 搜证 ${Object.keys(c.clues)[0]}`)];
  }
  if (game.type === '经营') return [host(`【群聊经营】「${game.topic}」开业！\n资金100，库存6，等级1。采购每份8，营业每份收入15，每天固定成本10。\n每次营业推进一天，最多30次行动。单独 @bot2 /玩法 行动 营业`), actor('bot4', '店员', '第一批客人快到了。我来接待，你们决定先备货还是直接开门。')];
  return [host(`【语音广播剧】主题：${game.topic}\nbot4、bot5 担任演员，读取当前人格和音色。每幕由你推进，最多6幕。\n单独 @bot2 /玩法 行动 下一幕 [剧情建议]` )];
}

// Canonical state is changed only by these rules. Models never choose culprits or change the ledger.
export function advanceGame(game, rawAction, now = Date.now(), participant = {}) {
  if (game.status !== 'active') return [host(`当前状态为 ${game.status}。管理员可 /玩法 继续 或 /玩法 结束。`)];
  const action = String(rawAction ?? '').trim().slice(0, 600);
  if (EXTRA_GAME_TYPES.includes(game.type)) return advanceExtraGame(game, action, participant, now);
  let messages;
  if (game.type === '侦探') {
    const c = CASES[game.data.caseIndex];
    let match;
    if ((match = /^搜证\s+(\S+)$/.exec(action))) {
      if (!c.clues[match[1]]) return [host(`可搜证地点：${Object.keys(c.clues).join('、')}`)];
      if (game.data.found.includes(match[1])) return [host(`该线索已找到：${c.clues[match[1]]}`)];
      game.data.found.push(match[1]);
      messages = [actor('bot3', '证据记录', `${match[1]}：${c.clues[match[1]]}`)];
    } else if ((match = /^询问\s+(\S+)$/.exec(action))) {
      const witness = c.witnesses[match[1]];
      if (!witness) return [host(`可询问：${Object.keys(c.witnesses).join('、')}`)];
      messages = [actor(witness.botId, match[1], witness.text)];
    } else if (action === '提示') {
      if (game.data.hints >= 2) return [host('两次提示已用完，请结合现有证据推理。')];
      game.data.hints++;
      messages = [host(`提示：优先搜证「${c.required.find((x) => !game.data.found.includes(x)) || c.required[0]}」，用物证检验证言。`)];
    } else if ((match = /^指认\s+(\S+)$/.exec(action))) {
      if (match[1] === c.culprit && c.required.every((x) => game.data.found.includes(x))) {
        game.status = 'completed';
        messages = [host(`【破案】${c.ending}\n案件已存档，可 /玩法 结束 后开启另一场。`)];
      } else messages = [host('这次指认尚未成立。请检查对象，并收集至少两条能互相印证的关键证据。')];
    } else return [host('侦探行动：搜证 <地点>、询问 <人物>、提示、指认 <人物>。')];
  } else if (game.type === '经营') {
    const d = game.data;
    let match;
    if ((match = /^采购\s+([1-9]|10)$/.exec(action))) {
      const count = Number(match[1]);
      if (d.cash < count * 8) return [host('资金不足；采购每份8。')];
      d.cash -= count * 8; d.stock += count;
      messages = [actor('bot3', '账房', `采购${count}份，支出${count * 8}；资金${d.cash}，库存${d.stock}。`)];
    } else if (action === '营业') {
      const events = ['晴天，附近社团来聚会', '下雨，来店客人减少', '有顾客推荐了你的店', '附近举办了小型市集'];
      const demand = [4, 2, 5, 6][(d.day - 1) % 4] + d.level - 1;
      const sold = Math.min(d.stock, demand);
      d.stock -= sold; d.cash += sold * 15 - 10; d.reputation += sold >= demand ? 1 : 0;
      messages = [actor('bot4', '店员', `第${d.day}天：${events[(d.day - 1) % 4]}。卖出${sold}份，收入${sold * 15}，固定支出10。`), actor('bot3', '账房', `日结：资金${d.cash}，库存${d.stock}，口碑${d.reputation}。${d.stock === 0 ? '明天开门前记得采购。' : ''}`)];
      d.day++;
      if (d.cash < 0) { game.status = 'completed'; messages.push(host('资金不足支付营业成本，本次经营结束，账本已保存。')); }
    } else if (action === '升级') {
      const cost = 60 * d.level;
      if (d.level >= 3) return [host('已达到最高等级3。')];
      if (d.cash < cost) return [host(`升级需要${cost}资金。`)];
      d.cash -= cost; d.level++;
      messages = [actor('bot5', '策划', `升级完成！等级${d.level}，以后每天需求增加1；资金剩余${d.cash}。`)];
    } else if (action === '休息') {
      d.day++;
      messages = [host('休息一天，不产生收入和费用。账本已保存。')];
    } else return [host('经营行动：采购 <1~10>、营业、升级、休息。')];
  } else {
    const match = /^下一幕(?:\s+([\s\S]+))?$/.exec(action);
    if (!match) return [host('广播剧行动：下一幕 [剧情建议]。只会推进一幕。')];
    const n = game.turn + 1;
    const suggestion = String(match[1] || '顺着上一幕发展').slice(0, 300);
    game.data.lastSuggestion = suggestion;
    messages = [host(`【第${n}/6幕】${game.topic}`),
      actor('bot4', '演员A', n === 6 ? '原来我们一直寻找的答案，就藏在一起走过的这段路里。谢谢你陪我来到这里。' : `这里的故事才刚开始。${n === 1 ? '我收到一封没有署名的信，你愿意陪我查清它的来处吗？' : '前面出现了新的线索，我们先一起看看，再决定往哪里走。'}`, true),
      actor('bot5', '演员B', n === 6 ? '那就把这一刻记下来吧。下一次冒险，我们还在这里见。' : '我在。先别急着下结论，也许这条线索会把我们带到意想不到的地方。', true)];
    if (n === 6) { game.status = 'completed'; messages.push(host('本剧结束，台词记录已存档。')); }
  }
  game.turn++; game.updatedAt = now;
  if (game.turn >= game.maxTurns && game.status === 'active') {
    game.status = 'completed'; messages.push(host('达到本场轮次上限，进度已保存。管理员可结束后开启新场。'));
  }
  return messages;
}

export class GameStore {
  constructor(file = GAME_FILE) { this.file = file; this.state = this.read(); }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, groups: {}, archives: [], seen: {} };
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
    if (state.version !== 1 || !state.groups) throw new Error('玩法存档格式不兼容');
    return { archives: [], seen: {}, ...state };
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }
  command(group, input) {
    const key = String(group);
    const eventKey = input.eventId ? `${key}:${input.eventId}` : null;
    if (eventKey && this.state.seen[eventKey]) return { duplicate: true, messages: [] };
    let game = this.state.groups[key];
    const messages = [];
    const respond = (text) => messages.push(host(text));
    const admin = input.isAdmin === true;
    if (input.action === 'help') respond(gameHelp);
    else if (input.action === 'status') respond(gameSummary(game));
    else if (['start', 'pause', 'resume', 'end', 'save'].includes(input.action) && !admin) respond('只有 bot2 管理员可以开启、暂停、继续、结束或手动存档。');
    else if (input.action === 'start') {
      if (game) respond('当前已有玩法存档，请先 /玩法 结束。');
      else if (!GAME_TYPES.includes(input.type)) respond(gameHelp);
      else {
        game = newGame(input.type, input.topic, input.senderId);
        this.state.groups[key] = game;
        messages.push(...gameOpening(game));
      }
    } else if (!game) respond('当前没有玩法。用 /玩法 帮助 查看入口。');
    else if (input.action === 'pause') { game.status = game.status === 'completed' ? 'completed' : 'paused'; respond('已暂停并保存进度。'); }
    else if (input.action === 'resume') {
      if (game.status === 'completed') respond('本场已完成，不能再推进；请结束后开启新场。');
      else { game.status = 'active'; respond(`已继续。${gameSummary(game)}`); }
    } else if (input.action === 'end') {
      this.state.archives.push({ group: key, game, endedAt: Date.now() });
      this.state.archives = this.state.archives.slice(-50);
      delete this.state.groups[key]; respond('本场已结束，完整进度已归档。');
    } else if (input.action === 'save') respond('已保存。所有有效行动也会自动存档。');
    else if (input.action === 'act') messages.push(...advanceGame(game, input.content, Date.now(), input));
    else respond(gameHelp);
    if (eventKey) this.state.seen[eventKey] = Date.now();
    this.state.seen = Object.fromEntries(Object.entries(this.state.seen).filter(([, at]) => Date.now() - at < 86400000).slice(-2000));
    const batch = { id: crypto.randomUUID(), group: key, gameId: game?.id, messages, cursor: 0, createdAt: Date.now(),
      replyContext: { targetId: input.targetId || undefined, msgId: input.eventId || undefined } };
    this.state.outbox ??= [];
    if (input.action === 'end') for (const entry of this.state.outbox) if (entry.group === key) entry.cursor = entry.messages.length;
    this.state.outbox = this.state.outbox.filter((entry) => entry.cursor < entry.messages.length).slice(-100);
    this.state.outbox.push(batch);
    this.save();
    return { gameId: game?.id, messages, batchId: batch.id };
  }
}
import {projectPath} from "../deployment/paths.mjs";

// 共享表情库客户端（bot4 / 后续 bot3、bot5 通用）
//
// 设计要点：
//   1. 标签离线建好（每个表情有 emotion / when / moods），机器人不必每次读图。
//   2. 「什么时候发」和「发哪张」都由工具层兜底，不指望模型自觉：
//      - 每会话冷却（默认 90 秒 1 条）与频率上限（默认 10 分钟 4 条）
//      - 最近发过的先排除，避免连着同一张
//   3. 状态持久化在 runtime/sticker-state.json，重启不丢。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {projectPath} from '../deployment/paths.mjs';

const ROOT = projectPath('');
const LIB_DIR = projectPath('shared/stickers');
const STATE_FILE = projectPath('runtime/sticker-state.json');

const DEFAULTS = {
  minIntervalMs: 90_000,          // 同一会话两条「自发」表情的最小间隔
  minIntervalAfterExplicitMs: 20_000, // 用户点名发过表情后，机器人自发的最小间隔（点名会占掉一点额度，但不该把自发堵死）
  windowMs: 600_000,              // 频率统计窗口
  maxInWindow: 4,                 // 窗口内最多几条（只统计自发）
  dedupeRecent: 3,                // 在候选中排除该会话最近发过的 N 张
};

const cache = new Map();

/** 读 JSON 时容忍 BOM（PowerShell 写文件很容易带上）。 */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function loadLibrary(botId) {
  if (cache.has(botId)) return cache.get(botId);
  const file = join(LIB_DIR, botId, 'library.json');
  if (!existsSync(file)) throw new Error(`表情库不存在：${file}`);
  const lib = readJson(file);
  if (!Array.isArray(lib.stickers) || lib.stickers.length === 0) throw new Error(`表情库为空：${file}`);
  lib.byIndex = new Map(lib.stickers.map((s) => [s.index, s]));
  lib.byMd5 = new Map(lib.stickers.map((s) => [String(s.md5).toLowerCase(), s]));
  lib.byEmojiId = new Map(lib.stickers.map((s) => [String(s.emojiId).toLowerCase(), s]));
  cache.set(botId, lib);
  return lib;
}

function readState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.bots) return parsed;
  } catch { /* 首次运行或文件损坏：从空状态开始 */ }
  return { schemaVersion: 1, bots: {} };
}

function writeState(state) {
  mkdirSync(join(ROOT, 'runtime'), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, STATE_FILE);
}

function chatState(state, botId, chatKey) {
  state.bots[botId] ??= { chats: {} };
  state.bots[botId].chats[chatKey] ??= { lastAt: 0, recent: [], sentAt: [] };
  return state.bots[botId].chats[chatKey];
}

/** 紧凑清单：给模型看的（序号 + 情绪 + 场景 + 画面），不含长 URL。 */
export function describeLibrary(botId) {
  const lib = loadLibrary(botId);
  const lines = lib.stickers.map((s) =>
    `${s.index}. [${s.emotion || '未分类'}] ${s.when || s.visual || ''}${s.moods.length ? ` (moods: ${s.moods.join('/')})` : ''}`);
  return `收藏表情共 ${lib.stickers.length} 个：\n${lines.join('\n')}\n可用的 mood 标签：${lib.moods.join(', ')}`;
}

/** 按序号 / md5 / emoji_id / random 精确取一张。 */
export function resolveExplicit(botId, ask) {
  const lib = loadLibrary(botId);
  const key = String(ask ?? '').trim();
  if (!key) return null;
  if (/^random$/i.test(key)) return lib.stickers[Math.floor(Math.random() * lib.stickers.length)];
  if (/^\d+$/.test(key)) return lib.byIndex.get(Number(key)) ?? null;
  const lower = key.toLowerCase();
  return lib.byMd5.get(lower) ?? lib.byEmojiId.get(lower) ?? null;
}

export function listMoods(botId) {
  return loadLibrary(botId).moods ?? [];
}

/**
 * 收藏表情包在 QQ CDN 上的访问 key。
 *
 * 实测（2026-09-21）：mface 段**必须带 key**，否则发出的消息里 url 缺少 key 参数，
 * 对方客户端加载不出来（现象＝“机器人说发了但你什么也没看到”）。
 * key 是包级别的（同一个 emoji_package_id 下所有表情共用一个 key），可以从
 * NapCat 上报的任意一条同包表情消息里抓到，抓到后记进 library.json 复用。
 */
export function getPackKey(botId) {
  return String(loadLibrary(botId).packKey ?? '');
}

export function rememberPackKey(botId, key) {
  const value = String(key ?? '').trim();
  if (!value) return false;
  const file = join(LIB_DIR, botId, 'library.json');
  const lib = readJson(file);
  if (lib.packKey === value) return false;
  lib.packKey = value;
  lib.packKeyUpdatedAt = new Date().toISOString();
  writeFileSync(file, `${JSON.stringify(lib, null, 2)}\n`, 'utf8');
  cache.delete(botId);
  return true;
}

/** 情绪近义/别名映射：库里没有这些标签时也能落到合适的一类。 */
const MOOD_ALIASES = {
  agree: 'joy', ok: 'joy', happy: 'joy', laugh_out: 'laugh', lol: 'laugh',
  thanks: 'shy', thank: 'shy', praise: 'shy', blush: 'shy',
  sad: 'comfort', cry: 'comfort', hug: 'comfort', support: 'comfort', worry: 'comfort',
  hello: 'greeting', hi: 'greeting', bye: 'farewell', goodnight: 'farewell', sleep: 'tired',
  sleepy: 'tired', exhausted: 'tired', tiredness: 'tired', awkward2: 'awkward',
  speechless2: 'speechless', annoyed: 'angry', mad: 'angry', shock: 'confused', surprised: 'confused',
  tease: 'teasing', smug: 'proud', chill: 'cool',
};

/** 把自己传给 pickSticker 的 mood 归一化（近义 → 库里的标签）。 */
export function normalizeMood(mood) {
  const wanted = String(mood ?? '').trim().toLowerCase();
  return MOOD_ALIASES[wanted] ?? wanted;
}

/**
 * 按情绪挑一张，并做冷却 / 去重判断。
 * @returns {{ok:true, sticker:object, reason:string} | {ok:false, reason:string}}
 */
export function pickSticker(botId, mood, chatKey, options = {}) {
  const lib = loadLibrary(botId);
  const cfg = { ...DEFAULTS, ...(options.limits ?? {}) };
  const state = readState();
  const chat = chatState(state, botId, chatKey ?? 'unknown');
  const now = Date.now();

  if (options.enforceLimits !== false) {
    // 上一次是「用户点名要的」表情时，只按较短间隔拦一下；自发发送才用完整冷却。
    const minInterval = chat.lastWasExplicit ? cfg.minIntervalAfterExplicitMs : cfg.minIntervalMs;
    if (now - chat.lastAt < minInterval) {
      return { ok: false, reason: `刚发过表情（${Math.round((now - chat.lastAt) / 1000)} 秒前），${chat.lastWasExplicit ? "点名之后" : ""}同一会话至少间隔 ${Math.round(minInterval / 1000)} 秒` };
    }
    chat.sentAt = chat.sentAt.filter((t) => now - t < cfg.windowMs);
    if (chat.sentAt.length >= cfg.maxInWindow) {
      return { ok: false, reason: `${Math.round(cfg.windowMs / 60000)} 分钟内已经自发发过 ${chat.sentAt.length} 条表情，别再刷了` };
    }
  }

  const wanted = normalizeMood(mood);
  let candidates = lib.stickers.filter((s) => wanted && s.moods.some((m) => m.toLowerCase() === wanted));
  let matched = 'exact';
  if (candidates.length === 0) {
    // 近义/兜底：先按 mood 同族，再退化成全库
    const relaxed = lib.stickers.filter((s) => wanted && s.moods.some((m) => m.toLowerCase().includes(wanted) || wanted.includes(m.toLowerCase())));
    candidates = relaxed.length ? relaxed : lib.stickers;
    matched = relaxed.length ? 'fuzzy' : 'fallback';
  }
  const fresh = candidates.filter((s) => !chat.recent.includes(s.index));
  const pool = fresh.length ? fresh : candidates;
  const sticker = pool[Math.floor(Math.random() * pool.length)];
  return { ok: true, sticker, reason: matched === 'exact' ? '按情绪匹配' : matched === 'fuzzy' ? '近义情绪匹配' : `没有「${wanted}」这类表情，改用其他表情` };
}

/** 记录一条已发送的表情。explicit=true（用户点名要的）只更新冷却时间，不占自发额度。 */
export function noteStickerSent(botId, chatKey, sticker, options = {}) {
  const cfg = { ...DEFAULTS, ...(options.limits ?? {}) };
  const explicit = options.explicit === true;
  const state = readState();
  const chat = chatState(state, botId, chatKey ?? 'unknown');
  const now = Date.now();
  chat.lastAt = now;
  chat.lastWasExplicit = explicit;
  if (!explicit)
    chat.sentAt = [...chat.sentAt.filter((t) => now - t < cfg.windowMs), now];
  chat.recent = [sticker.index, ...chat.recent.filter((i) => i !== sticker.index)].slice(0, cfg.dedupeRecent);
  chat.total = (chat.total ?? 0) + 1;
  writeState(state);
}

/** 诊断用：某会话最近发过什么。 */
export function stickerStatus(botId, chatKey) {
  const state = readState();
  const chat = state.bots?.[botId]?.chats?.[chatKey] ?? null;
  return chat ? { ...chat, now: Date.now() } : { lastAt: 0, recent: [], sentAt: [], total: 0, now: Date.now() };
}

/**
 * 发送时用哪个「文件引用」。
 *
 * 实测结论（2026-09-21）：
 *   - 走 OneBot 的 `mface` 段虽然能进聊天记录，但生成的图片 URL 是
 *     `gxh.vip.qq.com/club/item/parcel/item/<id>/raw300.gif` 这种需要 CDN key 的地址，
 *     **对方客户端往往加载不出来**（看起来就像“没收到”）。
 *   - 用本地文件当图片发（`{type:'image', file:'file:///.../NN-<md5>.png'}`）会上传到 QQ 自己的
 *     CDN，对方必定能渲染，视觉上和表情包一样。
 * 所以默认走 image；本地文件不存在时退回远程 url，再退回 mface（由工具决定）。
 */
export function stickerAssetRef(botId, sticker) {
  const lib = loadLibrary(botId);
  if (sticker?.file) {
    const abs = `${String(lib.dir).replace(/\\/g, '/').replace(/\/+$/, '')}/${sticker.file}`;
    if (existsSync(abs)) return { kind: 'file', ref: `file:///${abs}` };
  }
  if (sticker?.url) return { kind: 'url', ref: sticker.url };
  return null;
}

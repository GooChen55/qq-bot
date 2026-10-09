import fs from 'node:fs';

const CONFIG_PATH = projectPath("shared/wake-access.json");
let cached = null;
let cachedMtime = -1;

function load() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cached && stat.mtimeMs === cachedMtime) return cached;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || !parsed.bots) throw new Error('missing bots');
    cached = parsed;
    cachedMtime = stat.mtimeMs;
    return cached;
  } catch {
    // 配置损坏或丢失时一律拒绝，不能意外变成全开放。
    cached = null;
    cachedMtime = -1;
    return null;
  }
}

function matches(list, value) {
  if (!Array.isArray(list)) return false;
  const normalized = list.map((item) => String(item).trim()).filter(Boolean);
  return normalized.includes('*') || normalized.includes(String(value ?? '').trim());
}

/**
 * 每个 bot 的发信人门禁。这里只判断“谁”，允许哪些群仍由各 bot 原配置控制。
 * scope: private | group；userId: QQ 号或腾讯 OpenID。
 */
export function isWakeAllowed(botId, scope, userId) {
  const bot = load()?.bots?.[String(botId)];
  if (!bot) return false;
  return matches(scope === 'group' ? bot.groupUsers : bot.privateUsers, userId);
}

export function getWakeAccessSnapshot() {
  return load();
}

/**
 * 每个 bot 允许在哪些群被唤醒（共享配置里的「群」名单）。
 *
 * 返回 null = 本条配置没声明群列表 → 各通道继续用自己的原配置
 * （bot4 的 group_ids、bot5 的 allow.groups、bot3 的 access.groups），
 * 所以升级不会悄悄改掉老行为；返回数组 = 完全以这里为准（改完即时生效，不用重启）。
 */
export function groupAllowList(botId) {
  const groups = load()?.bots?.[String(botId)]?.groups;
  if (!groups || !Array.isArray(groups.allow)) return null;
  return groups.allow.map((item) => String(item).trim()).filter(Boolean);
}

/** 该群是否「必须 @ 或 / 才唤醒」（没有声明则 false）。 */
export function isMentionRequired(botId, groupId) {
  const groups = load()?.bots?.[String(botId)]?.groups;
  if (!groups || !Array.isArray(groups.mentionRequired)) return false;
  return matches(groups.mentionRequired, groupId);
}

// Only real OneBot @ segments count; text saying @name, @all, or quoting
// another message must not bypass an explicit-mention-only group.
export function explicitWakeReason(event) {
  const self = String(event?.self_id ?? '');
  const segments = Array.isArray(event?.message) ? event.message : [];
  if (self && segments.some(s => s?.type === 'at' && String(s.data?.qq) === self)) return 'atMention';
  const text = segments.filter(s => s?.type === 'text').map(s => s.data?.text ?? '').join('').trim();
  return text.startsWith('/') ? 'command' : null;
}

export function mentionMessageAllowed(botId, scope, groupId, event) {
  return scope !== 'group' || !isMentionRequired(botId, groupId) || Boolean(explicitWakeReason(event));
}

export function mentionWakeReasonAllowed(botId, key, reason, manual = false) {
  const match = /^group:(\d+)$/.exec(String(key));
  if (!match || !isMentionRequired(botId, match[1]) || manual) return true;
  return ['atMention', 'command', 'peerResult'].includes(String(reason).split(':')[0]);
}

/** 该群是否被显式禁止（deny 优先于 allow）。 */
export function isGroupDenied(botId, groupId) {
  const groups = load()?.bots?.[String(botId)]?.groups;
  if (!groups || !Array.isArray(groups.deny)) return false;
  return matches(groups.deny, groupId);
}
import {projectPath} from "../deployment/paths.mjs";

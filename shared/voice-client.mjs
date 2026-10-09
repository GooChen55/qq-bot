import fs from 'node:fs';

const CONFIG_FILE = projectPath("shared/voice-fleet.json");
let cached = null;
let cachedMtime = 0;
const sendTimes = new Map();

function loadConfig() {
  const stat = fs.statSync(CONFIG_FILE);
  if (!cached || stat.mtimeMs !== cachedMtime) {
    cached = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    cachedMtime = stat.mtimeMs;
  }
  return cached;
}

export function voiceConfig(botId) {
  const root = loadConfig();
  const bot = root.bots?.[botId] ?? {};
  return {
    enabled: bot.enabled !== false,
    replyMode: normalizeReplyMode(bot.replyMode, 'text'),
    serviceUrl: String(process.env.VOICE_SERVICE_URL || root.serviceUrl || 'http://127.0.0.1:9881').replace(/\/+$/, ''),
    profileId: String(bot.profileId || root.defaultProfileId || ''),
    language: String(bot.language || root.defaultLanguage || 'auto'),
    maxChars: Math.max(1, Math.min(1500, Number(bot.maxChars || root.maxChars) || 240)),
    maxPerHour: Math.max(1, Math.min(1000, Number(bot.maxPerHour || root.maxPerHour) || 12)),
    smartMaxChars: Math.max(20, Math.min(1500, Number(bot.smartMaxChars || root.smartMaxChars) || 120)),
    alwaysMaxChars: Math.max(20, Math.min(1500, Number(bot.alwaysMaxChars || root.alwaysMaxChars || bot.maxChars || root.maxChars) || 240)),
    longReplyPolicy: String(bot.longReplyPolicy || root.longReplyPolicy || 'voice-lead-and-text') === 'text' ? 'text' : 'voice-lead-and-text'
  };
}

export function normalizeReplyMode(value, fallback = 'text') {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'always' || mode === 'voice' || mode === 'on') return 'always';
  if (mode === 'smart' || mode === 'auto') return 'smart';
  if (mode === 'text' || mode === 'off') return 'text';
  return fallback;
}

export function voiceReplyMode(botId) {
  const cfg = voiceConfig(botId);
  return cfg.enabled ? cfg.replyMode : 'text';
}

export function voiceFriendlyText(input) {
  const text = String(input ?? '').trim();
  if (!text) return false;
  if (/```|`[^`]+`|https?:\/\/|www\.|[A-Za-z]:\\|(?:^|\s)\/(?:[\w.-]+\/)+|\|\s*[-:]{3,}\s*\|/m.test(text)) return false;
  if ((text.match(/[{}<>_=]/g) || []).length >= 4) return false;
  return true;
}

function voiceLeadText(input, maxChars) {
  const text = String(input ?? '').trim();
  if (text.length <= maxChars) return text;
  const parts = text.match(/[^。！？!?\n]+[。！？!?]?/g) || [];
  let lead = '';
  for (const part of parts) {
    if ((lead + part).length > maxChars) break;
    lead += part;
    if (lead.length >= Math.min(48, Math.floor(maxChars / 2))) break;
  }
  return (lead.trim() || text.slice(0, maxChars).replace(/[，、；：,:;\s]+$/u, '')).trim();
}

/**
 * Decide how a normal text reply should be delivered.
 * Explicit voice tools bypass this function and always synthesize.
 */
export function automaticVoicePlan(botId, input) {
  const cfg = voiceConfig(botId);
  const text = String(input ?? '').trim();
  if (!text || !cfg.enabled || cfg.replyMode === 'text' || !voiceFriendlyText(text)) {
    return { kind: 'text', text, reason: !cfg.enabled ? 'disabled' : cfg.replyMode === 'text' ? 'text-mode' : 'not-voice-friendly' };
  }
  const limit = Math.min(cfg.maxChars, cfg.replyMode === 'always' ? cfg.alwaysMaxChars : cfg.smartMaxChars);
  if (text.length <= limit) return { kind: 'voice', text, speechText: text, mode: cfg.replyMode };
  if (cfg.replyMode === 'smart' || cfg.longReplyPolicy === 'text') return { kind: 'text', text, reason: 'too-long' };
  return { kind: 'voice-and-text', text, speechText: voiceLeadText(text, limit), mode: cfg.replyMode };
}

function checkRate(botId, maxPerHour) {
  const now = Date.now();
  const recent = (sendTimes.get(botId) || []).filter((time) => now - time < 3600000);
  if (recent.length >= maxPerHour) throw new Error(`voice rate limit reached (${maxPerHour}/hour)`);
  sendTimes.set(botId, recent);
}

function recordSend(botId) {
  const recent = sendTimes.get(botId) || [];
  recent.push(Date.now());
  sendTimes.set(botId, recent);
}

export async function synthesizeFleetVoice(botId, text, options = {}) {
  const cfg = voiceConfig(botId);
  const clean = String(text ?? '').trim();
  if (!cfg.enabled) throw new Error(`${botId} voice is disabled in the fleet panel`);
  if (!clean) throw new Error('voice text is empty');
  if (clean.length > cfg.maxChars) throw new Error(`voice text exceeds ${cfg.maxChars} characters`);
  checkRate(botId, cfg.maxPerHour);
  const response = await fetch(`${cfg.serviceUrl}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: options.profileId || cfg.profileId,
      text: clean,
      textLang: options.textLang || options.language || cfg.language
    }),
    signal: AbortSignal.timeout(180000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false || !body.url) {
    throw new Error(body.error || body.message || `voice service HTTP ${response.status}`);
  }
  recordSend(botId);
  return body;
}

export async function synthesizeFleetVoiceBuffer(botId, text, options = {}) {
  const result = await synthesizeFleetVoice(botId, text, options);
  const response = await fetch(result.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`generated audio download failed: HTTP ${response.status}`);
  return { ...result, buffer: Buffer.from(await response.arrayBuffer()) };
}
import {projectPath} from "../deployment/paths.mjs";

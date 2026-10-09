import fs from 'node:fs';
import path from 'node:path';

const FLEET_FILE = projectPath("bots.json");
const ELIGIBLE_KINDS = new Set(['official-qqbot', 'onebot-napcat', 'external-bridge']);

export function debateBots(fleetFile = FLEET_FILE) {
  const fleet = JSON.parse(fs.readFileSync(fleetFile, 'utf8').replace(/^\uFEFF/, '')).fleet;
  if (!Array.isArray(fleet)) throw new Error('机器人机队登记表缺少 fleet 列表');
  return fleet.filter((bot) => bot?.id !== 'bot1'
    && /^bot\d+$/.test(String(bot?.id ?? ''))
    && bot.provisionState === 'ready'
    && ELIGIBLE_KINDS.has(bot.kind))
    .map((bot) => ({ id: bot.id, label: String(bot.label || bot.id).slice(0, 80), kind: bot.kind,
      accountQq: Number.isSafeInteger(Number(bot.accountQq)) ? String(bot.accountQq) : null }));
}

export function defaultDebateSettings(bots) {
  const ids = new Set(bots.map((bot) => bot.id));
  const host = ids.has('bot2') ? 'bot2' : bots[0]?.id ?? '';
  const available = bots.map((bot) => bot.id).filter((id) => id !== host);
  const pro = ids.has('bot3') && host !== 'bot3' ? 'bot3' : available[0];
  const contra = ids.has('bot4') && host !== 'bot4' && pro !== 'bot4'
    ? 'bot4' : available.find((id) => id !== pro);
  return {
    host,
    proBots: pro ? [pro] : [],
    contraBots: contra ? [contra] : [],
    allowHumanRebuttal: false,
  };
}

export function validateDebateSettings(input, bots) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('辩论设置必须是 JSON 对象');
  const available = new Set(bots.map((bot) => bot.id));
  const host = String(input.host ?? '');
  if (!available.has(host)) throw new Error('主持人不在可用机器人名单中');
  const normalizeTeam = (value, name) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error(`${name}至少 1 位，最多 4 位`);
    const ids = value.map((id) => String(id));
    if (new Set(ids).size !== ids.length) throw new Error(`${name}不能重复选择同一个机器人`);
    if (ids.some((id) => !available.has(id))) throw new Error(`${name}包含未登记或未就绪的机器人`);
    return ids;
  };
  const proBots = normalizeTeam(input.proBots, '正方');
  const contraBots = normalizeTeam(input.contraBots, '反方');
  if ([...proBots, ...contraBots].includes(host)) throw new Error('主持人必须中立，不能兼任辩手');
  if (proBots.some((id) => contraBots.includes(id))) throw new Error('一个机器人不能同时代表正反两方');
  if (typeof input.allowHumanRebuttal !== 'boolean') throw new Error('真人辩驳开关必须是布尔值');
  return { host, proBots, contraBots, allowHumanRebuttal: input.allowHumanRebuttal };
}

export class DebateSettings {
  constructor(file, roster = () => debateBots()) {
    this.file = file;
    this.roster = roster;
    this.saved = null;
    try { this.saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* use defaults */ }
  }

  current() {
    const bots = this.roster();
    const fallback = defaultDebateSettings(bots);
    let config = fallback;
    try { if (this.saved) config = validateDebateSettings(this.saved, bots); } catch { /* retired bot: fall back safely */ }
    return { bots, config };
  }

  update(input) {
    const bots = this.roster();
    const config = validateDebateSettings(input, bots);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
    this.saved = config;
    return { bots, config };
  }
}
import {projectPath} from "../../deployment/paths.mjs";

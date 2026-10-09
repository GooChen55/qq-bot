import fs from 'node:fs';
import path from 'node:path';

const clean = (value, size = 160) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, size);
function lineup(input) {
  const host = String(input?.host ?? 'bot2');
  const proBots = Array.isArray(input?.proBots) ? input.proBots.map(String) : ['bot3'];
  const contraBots = Array.isArray(input?.contraBots) ? input.contraBots.map(String) : ['bot4'];
  const ids = [host, ...proBots, ...contraBots];
  if (!/^bot\d+$/.test(host) || !proBots.length || !contraBots.length || proBots.length > 4 || contraBots.length > 4
    || ids.some((id) => !/^bot\d+$/.test(id))
    || new Set(ids).size !== ids.length) return null;
  return { host, proBots, contraBots, allowHumanRebuttal: input?.allowHumanRebuttal === true };
}

export class Debate {
  constructor(file, now = () => Date.now()) {
    this.file = file;
    this.now = now;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      this.state = data.version === 1 ? data : { version: 1, active: {}, recommendations: {}, history: [] };
    } catch { this.state = { version: 1, active: {}, recommendations: {}, history: [] }; }
    this.state.recommendations ??= {};
    for (const item of Object.values(this.state.active ?? {})) {
      if (!item.proBots) item.proBots = [String(item.pro ?? 'bot2')];
      if (!item.contraBots) item.contraBots = [String(item.contra ?? 'bot4')];
      item.host ??= 'bot5';
      item.humanRebuttals ??= [];
      item.allowHumanRebuttal ??= false;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temp, this.file);
  }

  active(group) { return this.state.active[String(group)] ?? null; }

  start(group, owner, topic, settings) {
    const title = clean(topic, 100);
    const selected = lineup(settings);
    if (title.length < 4) return { ok: false, message: '辩题至少 4 字。用法：/辩论 开始 辩题' };
    if (!selected) return { ok: false, message: '阵容无效：主持人与正反方不能重复，每方至少一位机器人。请在控制面板检查配置。' };
    if (this.active(group)) return { ok: false, message: '本群已有辩论；先用 /辩论 状态 查看。' };
    const item = { id: String(this.now()), group: String(group), owner: String(owner), topic: title, ...selected,
      stage: 'research', createdAt: this.now(), dueAt: null, sources: [], turns: {}, questions: [], humanRebuttals: [], votes: {} };
    this.state.active[item.group] = item;
    this.save();
    return { ok: true, item, message: `【辩论赛 #${item.id}】${title}\n主持 ${item.host}；正方 ${item.proBots.join('、')}（${item.proBots.length} 位），反方 ${item.contraBots.join('、')}（${item.contraBots.length} 位）。真人辩驳：${item.allowHumanRebuttal ? '允许' : '关闭'}。已按阵容分配各机器人发送通道，正在检索资料……` };
  }

  setRecommendations(group, items) {
    this.state.recommendations[String(group)] = { items: items.slice(0, 3), at: this.now() };
    this.save();
  }

  getRecommendation(group, number) {
    const value = this.state.recommendations[String(group)];
    if (!value || this.now() - value.at > 30 * 60 * 1000) return null;
    return value.items[number - 1] ?? null;
  }

  cachedRecommendations(group, maxAge = 48 * 60 * 60 * 1000) {
    const own = this.state.recommendations[String(group)];
    const value = own ?? Object.values(this.state.recommendations)
      .filter((entry) => Array.isArray(entry?.items) && entry.items.length)
      .sort((a, b) => Number(b.at) - Number(a.at))[0];
    if (!value || this.now() - Number(value.at) > maxAge) return [];
    return value.items;
  }

  update(group, id, patch) {
    const item = this.active(group);
    if (!item || item.id !== id) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  turn(group, id, key, text) {
    const item = this.active(group);
    if (!item || item.id !== id || item.turns[key]) return false;
    item.turns[key] = clean(text, 420);
    this.save();
    return true;
  }

  question(group, user, text) {
    const item = this.active(group);
    if (!item || item.stage !== 'questions' || this.now() >= item.dueAt) return '当前不在观众提问时段。';
    if (item.questions.some((q) => q.user === String(user))) return '每人限提一个问题。';
    if (item.questions.length >= 5) return '本场提问已满 5 条。';
    const question = clean(text, 100);
    if (question.length < 4) return '问题至少 4 字。';
    item.questions.push({ user: String(user), text: question });
    this.save();
    return `已收录提问（${item.questions.length}/5）。`;
  }

  humanRebuttal(group, user, side, text) {
    const item = this.active(group);
    if (!item?.allowHumanRebuttal) return '本场未开启真人辩驳。';
    if (item.stage !== 'questions' || this.now() >= item.dueAt) return '当前不在真人辩驳时段。';
    if (!['正方', '反方'].includes(side)) return '请指定 正方 或 反方。';
    if (item.humanRebuttals.some((entry) => entry.user === String(user))) return '每位群友本场限辩驳一次。';
    if (item.humanRebuttals.length >= 8) return '本场真人辩驳已满 8 条。';
    const content = clean(text, 180);
    if (content.length < 8) return '辩驳内容至少 8 字。';
    item.humanRebuttals.push({ user: String(user), side, text: content });
    this.save();
    return `已收录你对${side}的辩驳（${item.humanRebuttals.length}/8）。机器人交锋时会参考，未经核实的事实不会当作证据。`;
  }

  vote(group, user, side) {
    const item = this.active(group);
    if (!item || item.stage !== 'voting' || this.now() >= item.dueAt) return '当前不在投票时段。';
    if (!['正方', '反方'].includes(side)) return '只能投 正方 或 反方。';
    item.votes[String(user)] = side;
    this.save();
    return `已投${side}，投票期间可以改票。`;
  }

  status(group) {
    const item = this.active(group);
    if (!item) return '当前没有进行中的辩论。';
    const names = { research: '检索资料', opening: '开篇立论', questions: '观众提问', rebuttal: '交锋与核查', voting: '观众投票', interrupted: '中断，待主持人继续' };
    const remaining = item.dueAt ? `；剩余约 ${Math.max(0, Math.ceil((item.dueAt - this.now()) / 1000))} 秒` : '';
    return `【辩论赛 #${item.id}】${item.topic}\n主持 ${item.host}；正方 ${item.proBots.join('、')}（${item.proBots.length} 位）/ 反方 ${item.contraBots.join('、')}（${item.contraBots.length} 位）；当前：${names[item.stage] ?? item.stage}${remaining}；问题 ${item.questions.length} 条，真人辩驳 ${item.humanRebuttals.length} 条，投票 ${Object.keys(item.votes).length} 人。`;
  }

  finish(group, reason = '投票结束') {
    const item = this.active(group);
    if (!item) return null;
    delete this.state.active[String(group)];
    const pro = Object.values(item.votes).filter((v) => v === '正方').length;
    const contra = Object.values(item.votes).filter((v) => v === '反方').length;
    item.finishedAt = this.now();
    item.reason = reason;
    item.counts = { pro, contra };
    this.state.history.push(item);
    this.state.history = this.state.history.slice(-20);
    this.save();
    const outcome = pro + contra === 0 ? '无人投票，不判胜负' : pro === contra ? '平票' : `${pro > contra ? '正方' : '反方'}获观众票多数`;
    return `【辩论赛结束 #${item.id}】${item.topic}\n${reason}；正方 ${item.proBots.join('、')} ${pro} 票 / 反方 ${item.contraBots.join('、')} ${contra} 票。${outcome}。票数仅代表观众偏好，不等于事实判定。`;
  }
}

import crypto from 'node:crypto';

export const EXTRA_GAME_TYPES = ['海龟汤', '知识擂台', '合作冒险'];
const host = (text) => ({ botId: 'bot2', text });
const actor = (botId, role, text) => ({ botId, role, text });
const SOUPS = [
  { title: '没有乘客的末班车', opening: '末班车上没有一个乘客。司机却在最后一站停了很久，开门说了一声“谢谢”，然后才回车库。为什么？',
    facts: [
      { label: '车内确实没有乘客', test: /乘客|有人坐|车上有人/, answer: '车内确实没有乘客。' },
      { label: '司机在等站外的人', test: /等人|站外|站台|等谁/, answer: '是，司机在等站外的人。' },
      { label: '与雨天和遗失物有关', test: /下雨|雨天|雨伞|遗失|丢失/, answer: '是，与下雨和司机遗失的物品有关。' },
      { label: '有人归还司机的伞', test: /归还|还.*伞|送伞|失物/, answer: '是，站外的人来归还司机白天遗失的伞。' },
      { label: '这是现实中的普通事件', test: /死亡|鬼|梦|灵异/, answer: '否，没有死亡、灵异或梦境设定。' },
    ], solve: (s) => /伞/.test(s) && /归还|还给|送回|送还/.test(s),
    answer: '白天司机把伞落在终点站的便利店。店员约好末班车到站时归还；司机等店员拿来伞，开门道谢。没有乘客不等于站外没有人。' },
  { title: '迟到的生日蛋糕', opening: '女孩把生日蛋糕放进冰箱，却没有点蜡烛。第二天她取出蛋糕，向窗外说“生日快乐”。她并不孤单，也没有忘记生日。为什么？',
    facts: [
      { label: '蛋糕不是为她自己准备的', test: /自己|她的生日/, answer: '否，蛋糕不是为她自己的生日准备的。' },
      { label: '寿星在另一个时区', test: /时区|国外|外国|时间差/, answer: '是，寿星住在另一个时区。' },
      { label: '她通过网络与寿星联系', test: /视频|电话|网络|连线/, answer: '是，她正在通过视频连线祝福寿星。' },
      { label: '窗边的屏幕面向她', test: /窗|屏幕|电脑/, answer: '窗边放着视频连线用的屏幕，她是朝屏幕说话。' },
      { label: '没有死亡或灵异设定', test: /死亡|鬼|去世|灵异/, answer: '否，没有死亡或灵异设定。' },
    ], solve: (s) => /时区|时差/.test(s) && /视频|连线|屏幕/.test(s),
    answer: '她给住在另一个时区的朋友准备蛋糕。等到朋友当地生日开始，才在窗边视频连线庆祝，所以她当地已经是第二天。' },
];
const QUESTIONS = [
  { q: '一个非闰年有多少天？', choices: ['365', '366', '364'], correct: 'A', why: '非闰年二月有28天，全年365天。' },
  { q: '三角形内角和是多少度（欧氏平面）？', choices: ['90', '180', '360'], correct: 'B', why: '欧氏平面上的三角形内角和为180度。' },
  { q: '二进制的 10 等于十进制的多少？', choices: ['10', '1', '2'], correct: 'C', why: '1×2 + 0 = 2。' },
  { q: '声音通常不能在哪种环境传播？', choices: ['水', '空气', '真空'], correct: 'C', why: '声音传播需要介质。' },
  { q: '一小时等于多少秒？', choices: ['3600', '600', '60'], correct: 'A', why: '60分钟×每分钟60秒=3600秒。' },
];
const ANIME_QUESTIONS = [
  { q: '《葬送的芙莉莲》的芙莉莲属于什么种族？', choices: ['人类', '精灵', '矮人'], correct: 'B', why: '芙莉莲是精灵魔法使。' },
  { q: '《孤独摇滚！》中后藤一里主要演奏什么乐器？', choices: ['架子鼓', '贝斯', '吉他'], correct: 'C', why: '后藤一里是吉他手。' },
  { q: '《名侦探柯南》中江户川柯南原本的名字是什么？', choices: ['工藤新一', '服部平次', '怪盗基德'], correct: 'A', why: '工藤新一缩小后使用江户川柯南这个名字。' },
  { q: '《哆啦A梦》中哆啦A梦来自哪个世纪？', choices: ['20世纪', '21世纪', '22世纪'], correct: 'C', why: '哆啦A梦来自22世纪。' },
  { q: '《龙珠》中孙悟空所属的种族是什么？', choices: ['赛亚人', '那美克星人', '地球人'], correct: 'A', why: '孙悟空是赛亚人。' },
];
const SCENES = [
  { title: '雾中的岔路', story: '你们受托把一封密信送到山顶灯塔。浓雾中出现岔路。', choices: ['沿石阶慢行', '抄近路穿过荆棘'], effects: [{ supplies: -1 }, { hp: -2 }], notes: ['消耗一份补给，安全通过。', '节省补给，但荆棘让队伍失去2点体力。'] },
  { title: '溪边的旅人', story: '一位旅人请求一份补给，愿意用地图交换。', choices: ['交换地图', '婉拒并赶路'], effects: [{ supplies: -1, map: true }, {}], notes: ['得到地图，上面标出了旧桥旁的绳索。', '保留补给，依靠路标继续前进。'] },
  { title: '断裂的旧桥', story: '桥板松脱，对岸有通向山顶的路。', choices: ['寻找绳索加固桥面', '尝试跳过缺口'], effects: [{ supplies: -1 }, { hp: -2 }], notes: ['找到绳索，加固桥面；有地图时不消耗补给。', '成功跨过缺口，但落地扭伤，失去2点体力。'] },
  { title: '避雨的木屋', story: '暴雨将至，队伍发现一间无人木屋。', choices: ['休息并吃一份补给', '趁雨前继续赶路'], effects: [{ supplies: -1, hp: 2 }, { hp: -1 }], notes: ['休息恢复2点体力。', '赶到山腰，但疲劳让队伍失去1点体力。'] },
  { title: '灯塔前的石门', story: '门上有两个符号：太阳与月亮。密信封口画着一轮明月。', choices: ['按下月亮符号', '按下太阳符号'], effects: [{ seal: true }, { hp: -2 }], notes: ['石门打开，封口完整。', '触发机关，失去2点体力；随后用密信上的月亮解开门锁。'] },
  { title: '最后的托付', story: '守塔人伸出手。信封仍然封着，队伍的任务即将结束。', choices: ['交付未拆封的密信', '先拆开看看内容再交付'], effects: [{ delivered: true }, { delivered: true, opened: true }], notes: ['守塔人郑重接过密信，感谢你们守住托付。', '完成送达，但未能守住保密承诺。'] },
];
const puzzle = (g) => SOUPS[g.data.puzzleIndex];
const question = (g) => (g.data.bank === 'anime' ? ANIME_QUESTIONS : QUESTIONS)[g.data.questionIndex];
const options = (q) => q.choices.map((s, i) => `${'ABC'[i]} ${s}`).join('；');
function ranking(g) {
  return Object.values(g.data.scores).sort((a, b) => b.points - a.points).map((s) => `${s.label} ${s.points}分`).join('；') || '暂无得分';
}
function sceneText(g) {
  const s = SCENES[g.data.scene];
  return `【第${g.data.scene + 1}/6章·${s.title}】${s.story}\nA ${s.choices[0]}；B ${s.choices[1]}\n单独 @bot2 /玩法 行动 选择 A（或B）`;
}
export function initializeExtraGame(g) {
  if (g.type === '海龟汤') g.data = { puzzleIndex: /生日|蛋糕/.test(g.topic) ? 1 : 0, clues: [], hints: 0 };
  if (g.type === '知识擂台') g.data = { bank: /动漫|二次元/.test(g.topic) ? 'anime' : 'general', questionIndex: 0, scores: {}, attempted: [], hints: 0 };
  if (g.type === '合作冒险') g.data = { scene: 0, hp: 6, supplies: 4, map: false, seal: false, delivered: false, opened: false, choices: [] };
}
export function extraSummary(g) {
  if (g.type === '海龟汤') return `汤面：${puzzle(g).title}；已确认：${g.data.clues.join('、') || '无'}；提示 ${g.data.hints}/2`;
  if (g.type === '知识擂台') return `题库：${g.data.bank === 'anime' ? '动漫' : '通识'}；${g.status === 'completed' ? '已结算' : `第${g.data.questionIndex + 1}/5题`}；积分：${ranking(g)}`;
  if (g.type === '合作冒险') return `体力 ${g.data.hp}/6；补给 ${g.data.supplies}；地图 ${g.data.map ? '有' : '无'}；已完成 ${g.data.scene}/6章`;
  return '';
}
export function extraOpening(g) {
  if (g.type === '海龟汤') return [host(`【海龟汤·${puzzle(g).title}】${puzzle(g).opening}\n提问：/玩法 行动 提问 <问题>；提示：/玩法 行动 提示；解答：/玩法 行动 解答 <完整推理>。固定题库，不凭空补设定。`)];
  if (g.type === '知识擂台') return [host(`【知识擂台】${g.data.bank === 'anime' ? '动漫' : '通识'}五题赛，群友均可参加；每人每题只能答一次，首次答对得1分。\n${question(g).q}\n${options(question(g))}\n单独 @bot2 /玩法 行动 答案 A（或B/C）；可请求一次提示。`)];
  return [host(`【合作冒险·${g.topic}】六章送信任务。群友轮流决定，每次首个有效选择推进一章，共享体力和补给。\n${sceneText(g)}`)];
}

export function advanceExtraGame(g, action, participant = {}, now = Date.now()) {
  let messages;
  if (g.type === '海龟汤') {
    const p = puzzle(g);
    const ask = /^提问\s+(.+)$/.exec(action), solve = /^解答\s+(.+)$/.exec(action);
    if (ask) {
      const fact = p.facts.find((f) => f.test.test(ask[1]));
      // Supported, authored facts only; an unknown question never alters truth.
      if (!fact) return [host('该问题未覆盖，不能判定是或否。可从乘客、等待、遗失物（末班车）或时差、视频、窗边（蛋糕）等角度提问。')];
      if (!g.data.clues.includes(fact.label)) g.data.clues.push(fact.label);
      messages = [actor('bot3', '线索记录', fact.answer)];
    } else if (action === '提示') {
      if (g.data.hints >= 2) return [host('本场两次提示已用完。')];
      const hints = g.data.puzzleIndex === 0 ? ['车门内没有人，不代表车门外没有人。', '想想司机自己的遗失物，以及约定归还的时间。'] : ['同一个时刻，两地的日期可能不同。', '窗边不只有窗，也可能摆着连线的屏幕。'];
      messages = [actor('bot4', '提示者', hints[g.data.hints++])];
    } else if (solve) {
      if (!p.solve(solve[1])) messages = [host('还缺少关键因果，请结合已知线索再试。')];
      else { g.status = 'completed'; messages = [host(`【解汤成功】${p.answer}`)]; }
    } else return [host('行动格式：提问 <问题>、提示、解答 <推理>。')];
  } else if (g.type === '知识擂台') {
    const q = question(g), answer = /^答案\s+([ABCabc])$/.exec(action);
    if (action === '提示') {
      if (g.data.hints) return [host('本题提示已给出。')];
      g.data.hints = 1;
      const wrong = 'ABC'.split('').find((c) => c !== q.correct);
      return [actor('bot4', '提示者', `本题可排除选项 ${wrong}。`)];
    }
    if (!answer) return [host(`回答格式：答案 A、答案 B 或答案 C。\n${q.q}\n${options(q)}`)];
    const id = String(participant.senderId || '').trim();
    if (!id) return [host('无法识别参赛者，请从 QQ 群里单独 @bot2 作答。')];
    if (g.data.attempted.includes(id)) return [host('你已经答过本题，请留给其他群友，或等待下一题。')];
    if (g.data.attempted.length >= 200) return [host('本题参与人数达到上限200。')];
    g.data.attempted.push(id);
    if (answer[1].toUpperCase() !== q.correct) return [host('本次未答对。你本题的机会已使用，其他群友可以继续作答。')];
    const label = `玩家-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 6)}`;
    g.data.scores[id] ??= { label, points: 0 };
    g.data.scores[id].points++;
    messages = [actor('bot3', '计分员', `${label}答对，获得1分。${q.why}`)];
    g.data.questionIndex++; g.data.attempted = []; g.data.hints = 0;
    if (g.data.questionIndex === 5) { g.status = 'completed'; messages.push(host(`【擂台结算】${ranking(g)}。同分并列，不强行判胜负。`)); }
    else { const next = question(g); messages.push(host(`【第${g.data.questionIndex + 1}/5题】${next.q}\n${options(next)}`)); }
  } else {
    const choice = /^(?:选择\s+)?([ABab])$/.exec(action);
    if (!choice) return [host(sceneText(g))];
    const index = choice[1].toUpperCase() === 'A' ? 0 : 1, s = SCENES[g.data.scene], effect = { ...s.effects[index] };
    if (g.data.scene === 2 && index === 0 && g.data.map) effect.supplies = 0;
    if ((effect.supplies || 0) + g.data.supplies < 0) return [host('补给不足，请选另一个行动；无效选择不推进章节。')];
    const d = g.data;
    d.hp = Math.max(0, Math.min(6, d.hp + (effect.hp || 0))); d.supplies += effect.supplies || 0;
    for (const key of ['map', 'seal', 'delivered', 'opened']) if (effect[key]) d[key] = true;
    d.choices.push(choice[1].toUpperCase()); d.scene++;
    messages = [actor(d.scene % 2 ? 'bot5' : 'bot4', '旅途同伴', s.notes[index])];
    if (d.hp <= 0) { g.status = 'completed'; messages.push(host('【冒险结束】体力耗尽，队伍安全撤回驿站。路线已存档，下次可尝试节省体力。')); }
    else if (d.scene === 6) { g.status = 'completed'; messages.push(host(`【冒险结算】${d.opened ? '送达密信，但保密任务未完成。' : '密信完整送达，完成托付！'}\n${extraSummary(g)}`)); }
    else messages.push(host(`${sceneText(g)}\n体力${d.hp}/6；补给${d.supplies}`));
  }
  g.turn++; g.updatedAt = now;
  if (g.turn >= g.maxTurns && g.status === 'active') { g.status = 'completed'; messages.push(host('达到本场行动上限，进度已保存。')); }
  return messages;
}

import { createTurnCollector, unwrap } from './dsh-client.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function debateTurn(api, { workspaceId, prompt, timeoutMs = 90000 }) {
  const session = unwrap(await api.sessions.create({ workspaceId, agentPreset: 'debate-speaker' }), 'debate session.create');
  const sessionId = session.sessionId;
  try {
    const listing = unwrap(await api.sessions.list({ _request: {} }), 'debate session.list');
    let lastSeq = Number(listing.items?.find((item) => item.sessionId === sessionId)?.projections?.asOfSeq ?? 0);
    const collector = createTurnCollector();
    unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }), 'debate session.prompt');
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const page = unwrap(await api.sessions.list({ _request: {} }), 'debate session.list');
      const cursor = Number(page.items?.find((item) => item.sessionId === sessionId)?.projections?.asOfSeq ?? lastSeq);
      if (cursor > lastSeq) {
        const records = await api.fetchNewRecords(sessionId, lastSeq, cursor);
        for (const record of records.sort((a, b) => (a.event?.seq ?? 0) - (b.event?.seq ?? 0))) {
          lastSeq = Math.max(lastSeq, Number(record.event?.seq ?? 0));
          const done = collector.push(record.event);
          if (done) {
            const text = String(done.text ?? '').trim();
            if (!text) throw new Error('辩论代理没有输出文本');
            return text.slice(0, 420);
          }
        }
      }
      await delay(800);
    }
    throw new Error('辩论代理回合超时');
  } finally {
    try { await api.sessions.cancel({ sessionId }); } catch {}
    try { await api.workspace.archiveSession({ sessionId }); } catch {}
  }
}

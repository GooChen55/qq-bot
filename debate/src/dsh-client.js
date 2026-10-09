// DSH Web API 客户端（Node 侧）—— 面向 **DSH 0.1.5 的 Typert 网关协议**。
//
// 为什么不用官方 @deepseek-ai/dsh-host-apiproxy 的 AbstractApiClient：
//   那个包是 DSH 0.1.1 那一代的 host 插件协议，和 0.1.5 的网关在三处不兼容：
//     1) 鉴权：0.1.5 要「根路径 ?token= 换签名 Cookie」，裸 POST /api 一律 401；
//     2) 端点：0.1.5 是 `<namespace>/<method>`（斜杠），apiproxy 是 `ns.method`（点号）；
//     3) 事件流：0.1.5 没有 /api/events.mux（404），改由 WebSocket /api/remote.mux
//        承载的流式 Remote 方法 `$events`。
//   本文件保留 apiProxy 的**信封形状**（{ type:'server-response', rpcId, result:{ok,value} }），
//   以便 bridge.js 既有的 unwrap() / createTurnCollector() 消费方式不用改。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TOKEN_FILE = path.join(ROOT, 'state', 'dsh-token');
const DEFAULT_BASE = 'http://127.0.0.1:3080';

/** 桥用到的 apiproxy 方法名 -> 0.1.5 网关的 `namespace/method` 端点。 */
const ENDPOINT_MAP = {
  // 0.1.5 没有 host 命名空间，探活改用网关确实认领的 settings/describe
  'host.describe': 'settings/describe',
  'settings.describe': 'settings/describe',
  'settings.update': 'settings/update',
  'session.create': 'session/create',
  'session.list': 'session/list',
  'session.prompt': 'session/prompt',
  'session.cancel': 'session/cancel',
  'session.selectModel': 'session/selectModel',
  'session.history': 'session/page',
  'session.rename': 'session/rename',
  'workspace.create': 'workspace/create',
  'workspace.rename': 'workspace/rename',
  'workspace.archiveSession': 'workspace/archiveSession',
  'agentPreset.list': 'agentPreset/list',
};

/** 网关侧参数名与 apiproxy 不一致的端点（其余一律叫 request）。null = 无参。 */
const ARG_NAME = {
  'session/list': '_request',
  'settings/describe': null,
  'session/modelCatalog': null,
  'agentPreset/list': null,
};

function readTokenFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return '';
    // 既支持纯 token，也支持整条 http://...?token=xxx 的启动 URL
    const m = /[?&]token=([^&\s]+)/.exec(raw);
    return m ? m[1] : raw;
  } catch {
    return '';
  }
}

export class NodeApiClient {
  /**
   * @param baseUrl DSH Web 地址（默认 http://127.0.0.1:3080）
   * @param options.tokenFile 存放启动令牌的文件；默认 <repo>/state/dsh-token
   * @param options.token 直接给令牌（优先于文件）
   * @param options.timeoutMs unary 调用超时
   */
  constructor(baseUrl, options = {}) {
    this._createdSessionIds = new Set();
    this.baseUrl = String(baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;
    this.tokenFile = options.tokenFile ?? DEFAULT_TOKEN_FILE;
    this.tokenOverride = options.token ?? '';
    this._cookie = '';
    this._cookieToken = '';
    this._lastError = '';
  }

  get lastError() {
    return this._lastError;
  }

  token() {
    return this.tokenOverride || readTokenFile(this.tokenFile);
  }

  /** 用启动令牌换签名 Cookie（令牌每次 dsh web 启动都会变，Cookie 的签名密钥是持久的）。 */
  async ensureCookie() {
    const token = this.token();
    if (!token) throw new Error(`没有 DSH 启动令牌：请把 dsh web 启动时打印的 token 写入 ${this.tokenFile}`);
    if (this._cookie && this._cookieToken === token) return this._cookie;
    const res = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    if (res.status !== 303 && res.status !== 302) {
      throw new Error(`DSH 令牌交换失败：HTTP ${res.status}（令牌可能已过期，重启 dsh web 后重新写入 ${this.tokenFile}）`);
    }
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    const cookie = (raw ?? []).filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
    if (!cookie) throw new Error('DSH 令牌交换没有返回 Cookie');
    try { res.body?.cancel?.(); } catch {}
    this._cookie = cookie;
    this._cookieToken = token;
    return cookie;
  }

  /** 把 apiproxy 的调用体改写成网关调用体：payload -> { args: { <argName>: payload } }。 */
  buildPayload(endpoint, payload) {
    if (endpoint === '$events') return { args: {} };
    const argName = Object.hasOwn(ARG_NAME, endpoint) ? ARG_NAME[endpoint] : 'request';
    if (argName === null) return { args: {} };
    return { args: { [argName]: payload ?? {} } };
  }

  /** 把网关的 unary 响应包成 apiProxy 的信封形状。 */
  toEnvelope(rpcId, body) {
    const result = body?.result;
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      return { type: 'server-response', rpcId: body.rpcId ?? rpcId, result };
    }
    return {
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code: String(body?.error?.code ?? 'gateway/internal'),
          message: String(body?.error?.message ?? 'unknown gateway error'),
          details: {},
        },
      },
    };
  }

  /**
   * 与 apiProxy 的 `api.<domain>.<method>(payload)` 等价的调用。
   * 返回 apiProxy 形状的信封；业务错误不抛异常，交由 unwrap() 决定。
   */
  async call(method, payload, signal) {
    const endpoint = ENDPOINT_MAP[method];
    if (!endpoint) throw new Error(`未映射的 DSH 方法：${method}`);
    const cookie = await this.ensureCookie();
    const rpcId = crypto.randomUUID();
    const args = { ...(payload ?? {}) };
    // 0.1.5 的 session/prompt 必须带 requestId（SessionRequestId = 品牌化字符串）；
    // 桥的业务代码不传，这里统一补齐，避免逐个调用点改动。
    if (endpoint === 'session/prompt' && typeof args.requestId !== 'string') {
      args.requestId = rpcId;
    }
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: this.buildPayload(endpoint, args),
    });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body,
      signal: composed,
    });
    const text = await res.text();
    if (res.status === 401) {
      this._cookie = ''; // 令牌/Cookie 失效，下次重换
      this._lastError = 'HTTP 401 unauthorized（需要 ?token= 交换出的 Cookie）';
      throw new Error(this._lastError);
    }
    if (res.status === 404) {
      this._lastError = `HTTP 404：端点 /api/${endpoint} 未被网关认领`;
      throw new Error(this._lastError);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this._lastError = `响应不是 JSON：${text.slice(0, 120)}`;
      throw new Error(this._lastError);
    }
    return this.toEnvelope(rpcId, parsed);
  }

  /** apiProxy 兼容面 */
  get host() {
    return { describe: (payload, signal) => this.call('host.describe', payload, signal) };
  }

  get settings() {
    return {
      describe: (payload, signal) => this.call('settings.describe', payload, signal),
      update: (payload, signal) => this.call('settings.update', payload, signal),
    };
  }

  get sessions() {
    return {
      create: async (payload, signal) => {
        const response = await this.call('session.create', payload, signal);
        const id = response?.result?.ok ? response.result.value?.sessionId : null;
        if (id) this._createdSessionIds.add(id);
        return response;
      },
      list: (payload, signal) => this.call('session.list', payload, signal),
      prompt: (payload, signal) => this.call('session.prompt', payload, signal),
      cancel: (payload, signal) => this.call('session.cancel', payload, signal),
      selectModel: (payload, signal) => this.call('session.selectModel', payload, signal),
      history: (payload, signal) => this.call('session.history', payload, signal),
      rename: (payload, signal) => this.call('session.rename', payload, signal),
    };
  }

  get workspace() {
    return {
      create: (payload, signal) => this.call('workspace.create', payload, signal),
      rename: (payload, signal) => this.call('workspace.rename', payload, signal),
      archiveSession: (payload, signal) => this.call('workspace.archiveSession', payload, signal),
    };
  }

  get agentPreset() {
    return { list: (payload, signal) => this.call('agentPreset.list', payload, signal) };
  }

  // ── 会话事件投递 ──────────────────────────────────────────────────────────
  // DSH 0.1.5 的 /api/events.mux 不存在；实时对话事件由 **session/page**（HTTP）
  // 分页读取，`$events` 那条 WebSocket 流只推会话级状态（api-session/*），不含 turn 内容。
  // 因此这里用「轮询 session/page + 按 seq 去重」合成 bridge.js 期望的 session/event 帧。
  get events() {
    return { mux: (payload, signal, onOpen) => this.pollSessionEvents(signal, onOpen) };
  }

  /** 从一个 Remote 地址对象里取会话 id。 */
  static sessionIdOf(value) {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.sessionId === 'string') return value.sessionId;
    if (value.address?.kind === 'session' && typeof value.address.sessionId === 'string') return value.address.sessionId;
    return '';
  }

  /** 每轮取最近活跃的少量顶层会话。会话数量可能上百，取最近 N 个即可覆盖桥正在用的会话。 */
  async listWatchedSessions() {
    const page = unwrap(await this.sessions.list({ _request: {} }), 'session/list');
    const items = Array.isArray(page?.items) ? page.items : [];
    return items
      // 只要顶层会话：subagent 子会话的 id 是裸 UUID，父会话才带 session- 前缀
      .filter((it) => typeof it?.sessionId === 'string'
        && it.sessionId.startsWith('session-')
        && it.parentSessionId === undefined)
      .sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1))
      .slice(0, WATCH_SESSION_LIMIT)
      // asOfSeq 是该会话当前最新事件序号，用作首次监视的基线（免得重放历史）
      .map((it) => ({ sessionId: it.sessionId, asOfSeq: it.projections?.asOfSeq ?? 0 }));
  }

  /**
   * 拉取某会话「lastSeq 之后」的新事件。
   * session/page 语义（实测）：记录按 seq 升序返回；throughSeq 是**包含式上界**，
   * 但**不允许超过该会话的真实游标**（超了报 `through seq N is past cursor M`）。
   * 所以先用 asOfSeq（来自 session/list 的 projections.asOfSeq）当上界，
   * 被拒时从错误里取出真实游标重试一次。
   */
  async fetchNewRecords(sessionId, lastSeq, throughSeqHint) {
    const DEBUG = process.env.DSH_CLIENT_DEBUG === '1';
    const collected = [];
    let throughSeq = Number.isFinite(throughSeqHint) && throughSeqHint > 0 ? throughSeqHint : 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      let result;
      try {
        result = unwrap(await this.sessions.history({
          address: { kind: 'session', sessionId },
          throughSeq,
          maxMessages: MAX_RECORDS_PER_PAGE,
        }), 'session/page');
      } catch (error) {
        const m = /past cursor (\d+)/.exec(String(error?.message ?? ''));
        if (m && attempt === 0) { throughSeq = Number(m[1]); continue; }
        this._lastError = String(error?.message ?? error);
        if (DEBUG) console.log(`[dsh-client]     page 失败 ${sessionId.slice(0, 20)}: ${this._lastError}`);
        return collected;
      }
      const records = Array.isArray(result?.records) ? result.records : [];
      if (DEBUG && records.length) {
        const seqs = records.map((r) => r.event?.seq ?? 0);
        console.log(`[dsh-client]     page ${sessionId.slice(0, 20)} ${records.length} 条 seq ${Math.min(...seqs)}..${Math.max(...seqs)} lastSeq=${lastSeq}`);
      }
      for (const record of records) {
        const seq = record?.event?.seq;
        if (Number.isFinite(seq) && seq > lastSeq) collected.push(record);
      }
      return collected;
    }
    return collected;
  }

  async *pollSessionEvents(signal, onOpen) {
    const DEBUG = process.env.DSH_CLIENT_DEBUG === '1';
    const dbg = (...a) => { if (DEBUG) console.log('[dsh-client]', ...a); };
    const own = signal === undefined ? new AbortController() : undefined;
    const sig = signal ?? own.signal;
    // 先确认鉴权可用，再声明流已打开（bridge 会等 onOpen 后才投 prompt）
    await this.ensureCookie();
    onOpen?.();
    dbg('pollSessionEvents 启动');

    /** sessionId -> { lastSeq, cursor, synthesizing } */
    const state = new Map();

    while (!sig.aborted) {
      let watched = [];
      try {
        watched = await this.listWatchedSessions();
      } catch (error) {
        this._lastError = `session/list 失败：${error?.message ?? error}`;
      }
      dbg(`tick: 待轮询 ${watched.length} 个会话`);

      for (const { sessionId, asOfSeq } of watched) {
        if (sig.aborted) return;
        let st = state.get(sessionId);
        if (!st) {
          // Existing sessions start at the current head; sessions created by
          // this client start at zero so sub-second replies are never lost.
          const createdHere = this._createdSessionIds.delete(sessionId);
          st = { lastSeq: createdHere ? 0 : (Number.isFinite(asOfSeq) ? asOfSeq : 0), asOfSeq: asOfSeq ?? 0 };
          state.set(sessionId, st);
          dbg(`  新增监视 ${sessionId} 基线 lastSeq=${st.lastSeq}`);
          if (!createdHere) continue;
        }
        st.asOfSeq = Number.isFinite(asOfSeq) ? asOfSeq : st.asOfSeq;
        try {
          const records = await this.fetchNewRecords(sessionId, st.lastSeq, st.asOfSeq);
          if (records.length === 0) continue;
          dbg(`  ${sessionId} 新记录 ${records.length} 条`);
          const ordered = [];
          for (const record of records) {
            const event = record?.event;
            if (!event?.type) continue;
            ordered.push({ type: 'session/event', sessionId, event });
          }
          ordered.sort((a, b) => (a.event.seq ?? 0) - (b.event.seq ?? 0));
          dbg(`  → 投递 ${ordered.length} 帧（seq ${ordered[0]?.event?.seq}..${ordered[ordered.length - 1]?.event?.seq}）`);
          for (const frame of ordered) {
            st.lastSeq = Math.max(st.lastSeq, frame.event.seq ?? st.lastSeq);
            yield { type: 'server-request', rpcId: '', payload: frame };
          }
        } catch (error) {
          this._lastError = `session/page 失败：${error?.message ?? error}`;
          dbg(`  ${sessionId} 轮询异常: ${error?.message ?? error}`);
        }
      }
      await sleep(POLL_INTERVAL_MS, sig);
    }
    own?.abort();
  }
}

const POLL_INTERVAL_MS = 800;
const MAX_PAGES_PER_TICK = 6;
const MAX_RECORDS_PER_PAGE = 200;
const WATCH_SESSION_LIMIT = 60;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response?.result?.ok) return response.result.value;
  const { code, message } = response?.result?.error ?? { code: 'unknown', message: 'no result' };
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    push(event) {
      if (!event?.type) return null;
      if (event.type === 'turn/start') {
        turns.set(event.data?.turn, { text: '' });
        return null;
      }
      // 忽略流式分块：assistant/message 已携带完整文本，两者都累加会导致回复翻倍
      if (event.type === 'assistant/chunk') return null;
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data?.turn);
        if (!t) return null;
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data?.turn);
        turns.delete(event.data?.turn);
        if (!t) return null;
        return { turn: event.data?.turn, reason: event.data?.reason ?? { kind: 'unknown' }, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    },
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

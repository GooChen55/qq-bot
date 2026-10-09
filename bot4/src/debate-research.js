import { safeFetch } from './safe-fetch.js';

function plain(html) {
  return String(html ?? '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:amp|#38);/gi, '&').replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:lt|#60);/gi, '<').replace(/&(?:gt|#62);/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function parseSearchResults(html, limit = 5) {
  const out = [];
  for (const block of String(html).split('<li class="b_algo"').slice(1)) {
    const url = block.match(/<a[^>]+href="(https?:\/\/[^"\s]+)"/i)?.[1];
    const title = plain(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]);
    if (!url || !title) continue;
    try {
      const parsed = new URL(url.replace(/&amp;/g, '&'));
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      out.push({ title: title.slice(0, 100), url: parsed.href, snippet: plain(block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]).slice(0, 260) });
    } catch { /* malformed search result */ }
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchDebate(query, limit = 5) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(String(query).slice(0, 140))}`;
  const result = await safeFetch(url, 180000);
  if (result.statusCode !== 200) throw new Error(`搜索服务 HTTP ${result.statusCode}`);
  return parseSearchResults(result.body, limit);
}

export async function researchDebate(topic, { currentEvents = false, seedUrl = null, seedTitle = null, seedPublished = null, seedExcerpt = null } = {}) {
  let results = [];
  try { results = await searchDebate(`${topic} ${currentEvents ? '新闻' : '资料'}`, 6); } catch { /* seeded source may still work */ }
  if (seedUrl) results.unshift({ title: seedTitle || topic, url: seedUrl, snippet: '' });
  const sources = [];
  for (const result of results) {
    if (sources.length >= 3) break;
    try {
      const page = await safeFetch(result.url, 30000);
      if (page.statusCode < 200 || page.statusCode >= 400) continue;
      const published = page.body.match(/(?:datePublished|article:published_time)[^>]{0,150}(?:content=|"\s*:\s*)["'](\d{4}-\d{2}-\d{2})/i)?.[1]
        ?? page.body.match(/<time[^>]+datetime=["'](\d{4}-\d{2}-\d{2})/i)?.[1]
        ?? (result.url === seedUrl && seedPublished ? new Date(seedPublished).toISOString().slice(0, 10) : null);
      sources.push({ id: sources.length + 1, title: result.title, url: result.url, published, kind: 'article',
        retrievedAt: new Date().toISOString(), excerpt: result.url === seedUrl && seedExcerpt ? plain(seedExcerpt).slice(0, 900) : plain(page.body).slice(0, 900) });
    } catch {
      if (result.url === seedUrl && seedExcerpt && seedPublished) {
        sources.push({ id: sources.length + 1, title: seedTitle || topic, url: seedUrl,
          published: new Date(seedPublished).toISOString().slice(0, 10), kind: 'rss-summary',
          retrievedAt: new Date().toISOString(), excerpt: plain(seedExcerpt).slice(0, 900) });
      }
    }
  }
  if (!sources.length) throw new Error('没有可读取的网页资料，不能启动有事实依据的辩论');
  return sources;
}

export async function recommendDebateTopics() {
  const fetchFeed = async (name) => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await safeFetch(`https://www.chinanews.com.cn/rss/${name}`, 20000);
        if (result.statusCode === 200 && result.body.includes('<item>')) return result;
        lastError = new Error(`${name} HTTP ${result.statusCode}`);
      } catch (error) { lastError = error; }
    }
    throw lastError;
  };
  const names = ['scroll-news.xml', 'china.xml', 'world.xml', 'finance.xml', 'society.xml'];
  const fetched = await Promise.allSettled(names.map(fetchFeed));
  const feeds = fetched.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  if (!feeds.length) throw new Error('时事源暂不可访问');
  const rows = [];
  const relevant = /政策|标准|国标|规划|改革|试点|立法|法规|法案|禁令|开放|限制|通车/;
  const inappropriate = /审查调查|纪律审查|遇难|身亡|逝世|受伤|事故|直播|外链|海报|发布会/;
  for (const match of feeds.filter((f) => f.statusCode === 200).flatMap((f) => [...f.body.matchAll(/<item>([\s\S]*?)<\/item>/g)])) {
    const xml = match[1];
    const title = plain(xml.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const url = plain(xml.match(/<link>([\s\S]*?)<\/link>/)?.[1]);
    const published = plain(xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]);
    const excerpt = plain(xml.match(/<description>([\s\S]*?)<\/description>/)?.[1]).slice(0, 900);
    const at = Date.parse(published);
    if (!relevant.test(title) || inappropriate.test(title) || !Number.isFinite(at) || Math.abs(Date.now() - at) > 72 * 3600_000) continue;
    if (!/^https:\/\/www\.chinanews\.com\.cn\//.test(url)) continue;
    const repeated = rows.some((row) => row.url === url || ['高铁', '纸浆', '科学院'].some((term) => title.includes(term) && row.title.includes(term)));
    if (repeated) continue;
    rows.push({ number: rows.length + 1, title, url, motion: `针对「${title}」，相关做法利大于弊`, published, excerpt });
    if (rows.length >= 3) break;
  }
  return rows;
}

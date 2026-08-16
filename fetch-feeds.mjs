#!/usr/bin/env node
/* Gom RSS phía máy chủ rồi ghi ra data.json.
   Chạy trên GitHub Actions nên KHÔNG dính CORS -> gọi thẳng feed, không qua cầu nối.
   Danh sách nguồn đọc trực tiếp từ mảng SOURCES trong index.html, để bạn chỉ phải
   thêm/bớt nguồn ở một chỗ duy nhất.

   Dùng:  node fetch-feeds.mjs [index.html] [data.json]
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const HTML_FILE = process.argv[2] || 'index.html';
const OUT_FILE  = process.argv[3] || 'data.json';

const MAX_PER_SOURCE = 25;
const MAX_ITEMS      = 900;
const TIMEOUT_MS     = 20000;
const CONCURRENCY    = 8;
const UA = 'Mozilla/5.0 (compatible; tin-tuc-reader/1.0; +https://github.com)';

/* ---------- lấy danh sách nguồn từ index.html ---------- */
function readSources(html){
  const m = html.match(/const SOURCES\s*=\s*(\[[\s\S]*?\n\]);/);
  if (!m) throw new Error(`Không tìm thấy mảng SOURCES trong ${HTML_FILE}`);
  const list = new Function(`return ${m[1]}`)();
  return list.filter(s => s.enabled !== false && s.url);
}

/* ---------- tiện ích ---------- */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
  htmlEntities: true
});

const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = v => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return String(v['#text'] ?? v['__cdata'] ?? '');
  return '';
};
const stripHtml = h => String(h || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

function pickLink(item){
  const l = item.link;
  if (typeof l === 'string') return l;
  for (const cand of asArray(l)){
    if (typeof cand === 'string') return cand;
    if (cand && cand['@_rel'] !== 'self' && cand['@_href']) return cand['@_href'];
  }
  return text(item.guid) || text(item['@_rdf:about']) || '';
}

/* Google News bọc link thật trong link chuyển hướng -> lấy lại link gốc trong mô tả */
function cleanLink(link, descHtml){
  try{
    if (new URL(link).hostname.includes('news.google.com') && descHtml){
      const m = String(descHtml).match(/href="(https?:\/\/(?!news\.google)[^"]+)"/);
      if (m) return m[1].replace(/&amp;/g, '&');
    }
  }catch{}
  return link;
}

function parseFeed(xml, src){
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? doc?.feed ?? {};
  // RSS 2.0 -> rss.channel.item | RSS 1.0 -> rdf:RDF.item | Atom -> feed.entry
  const nodes = asArray(channel.item ?? channel.entry).slice(0, MAX_PER_SOURCE);

  const out = [];
  for (const n of nodes){
    const descRaw = n['content:encoded'] ?? n.description ?? n.summary ?? n.content ?? '';
    let title = stripHtml(text(n.title) || (typeof n.title === 'object' ? text(n.title['#text']) : ''));
    if (src.url.includes('news.google.com')) title = title.replace(/\s+-\s+[^-]{2,30}$/, '');
    const link = cleanLink(pickLink(n), text(descRaw) || descRaw);
    if (!title || !link) continue;

    const dateStr = text(n.pubDate) || text(n.published) || text(n.updated) || text(n['dc:date']);
    const d = dateStr ? new Date(dateStr) : null;

    out.push({
      t: title,
      l: link,
      s: stripHtml(text(descRaw) || descRaw).slice(0, 300),
      d: d && !isNaN(d) ? d.toISOString() : null,
      i: src.id, n: src.name, c: src.color
    });
  }
  return out;
}

async function fetchText(url){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

/* ---------- chạy ---------- */
const sources = readSources(readFileSync(HTML_FILE, 'utf8'));
console.log(`Có ${sources.length} nguồn cần lấy`);

const status = {};
const all = [];
const queue = sources.slice();

async function worker(){
  while (queue.length){
    const s = queue.shift();
    try{
      const xml = await fetchText(s.url);
      if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('không phải RSS/Atom');
      const items = parseFeed(xml, s);
      if (!items.length) throw new Error('feed rỗng');
      all.push(...items);
      status[s.id] = { count: items.length, error: null };
      console.log(`  ✓ ${s.name}: ${items.length} bài`);
    }catch(e){
      status[s.id] = { count: 0, error: String(e.message || e) };
      console.log(`  ✗ ${s.name}: ${e.message || e}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

/* bỏ trùng link, nhớ luôn các nguồn cùng đăng để lọc theo chuyên mục vẫn đúng */
const map = new Map();
for (const it of all){
  const old = map.get(it.l);
  if (!old){ it.a = []; map.set(it.l, it); continue; }
  if (old.i !== it.i && !old.a.includes(it.i)) old.a.push(it.i);
}
const items = [...map.values()]
  .sort((x, y) => new Date(y.d || 0) - new Date(x.d || 0))
  .slice(0, MAX_ITEMS);

writeFileSync(OUT_FILE, JSON.stringify({ at: Date.now(), sources: status, items }));

const ok = Object.values(status).filter(v => !v.error).length;
console.log(`\nXong: ${items.length} bài từ ${ok}/${sources.length} nguồn -> ${OUT_FILE}`);
if (!items.length){
  console.error('Không lấy được bài nào — dừng để không ghi đè data.json cũ bằng file rỗng.');
  process.exit(1);
}

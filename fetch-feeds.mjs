#!/usr/bin/env node
/* Gom RSS phía máy chủ rồi ghi ra data.json.
   Chạy trên GitHub Actions nên KHÔNG dính CORS -> gọi thẳng feed, không qua cầu nối.
   Danh sách nguồn đọc trực tiếp từ mảng SOURCES trong index.html, để bạn chỉ phải
   thêm/bớt nguồn ở một chỗ duy nhất.

   Dùng:  node fetch-feeds.mjs [index.html] [data.json]

   Biến môi trường:
     EXTRACT=0          tắt bóc toàn văn trang gốc
     EXTRACT_MAX=600    số bài mới tối đa mỗi lần chạy
     EXTRACT_PER_SRC=15 trần bài mới mỗi nguồn
     EXTRACT_CONC=8     số worker bóc song song
*/
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

const HTML_FILE = process.argv[2] || 'index.html';
const OUT_FILE  = process.argv[3] || 'data.json';

const SCHEMA_VERSION = 2;

const MAX_PER_SOURCE  = 25;
const MAX_ITEMS       = 1200;
const KEEP_PER_SOURCE = 12;
const CONTENT_DIR     = 'content';
const MIN_CONTENT     = 900;
const MAX_ITEM_HTML   = 60 * 1024;
const MAX_SHARD       = 1500 * 1024;

const EXTRACT         = process.env.EXTRACT !== '0';
const EXTRACT_MAX     = Number(process.env.EXTRACT_MAX || 600);
const EXTRACT_PER_SRC = Number(process.env.EXTRACT_PER_SRC || 15);
const EXTRACT_CONC    = Number(process.env.EXTRACT_CONC || 8);
const PAGE_TIMEOUT    = 15000;
const MAX_PAGE_BYTES  = 3 * 1024 * 1024;
const TIMEOUT_MS      = 20000;
const CONCURRENCY     = 8;
const FETCH_RETRIES   = 2;

const UA = 'Mozilla/5.0 (compatible; tin-tuc-reader/1.0; +https://github.com)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const GNEWS_RE = /^https?:\/\/news\.google\.com\//i;
const BING_NEWS_RE = /^https?:\/\/(?:www\.)?bing\.com\/news\//i;

function readSources(html) {
  const m = html.match(/const SOURCES\s*=\s*(\[[\s\S]*?\n\]);/);
  if (!m) throw new Error(`Không tìm thấy mảng SOURCES trong ${HTML_FILE}`);
  const list = new Function(`return ${m[1]}`)();
  return list.filter(s => s.enabled !== false && s.url);
}

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

const stripHtml = h =>
  String(h || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

function pickLink(item) {
  const l = item.link;
  if (typeof l === 'string') return l;
  for (const cand of asArray(l)) {
    if (typeof cand === 'string') return cand;
    if (cand && cand['@_rel'] !== 'self' && cand['@_href']) return cand['@_href'];
  }
  return text(item.guid) || text(item['@_rdf:about']) || '';
}

function unwrapRedirect(link) {
  let cur = link;
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(cur); } catch { return cur; }
    let next = null;
    for (const key of ['url', 'u', 'q', 'target', 'redirect']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v) && v !== cur) { next = v; break; }
    }
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

function cleanLink(link, descHtml) {
  const mo = unwrapRedirect(link);
  if (mo !== link) return mo;
  try {
    if (GNEWS_RE.test(link) && descHtml) {
      const m = String(descHtml).match(/href="(https?:\/\/(?!news\.google)[^"]+)"/);
      if (m) return unwrapRedirect(m[1].replace(/&amp;/g, '&'));
    }
  } catch {}
  return link;
}

function isTransientError(err) {
  const msg = String(err?.message || err || '');
  return /abort|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network|fetch failed|HTTP 5\d\d|HTTP 429/i.test(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function writeAtomic(path, body) {
  const tmp = path + '.tmp';
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

function parseFeed(xml, src) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? doc?.feed ?? {};
  const nodes = asArray(channel.item ?? channel.entry).slice(0, MAX_PER_SOURCE);
  const out = [];
  for (const n of nodes) {
    const descRaw = n['content:encoded'] ?? n.description ?? n.summary ?? n.content ?? '';
    let title = stripHtml(text(n.title) || (typeof n.title === 'object' ? text(n.title['#text']) : ''));
    const link = cleanLink(pickLink(n), text(descRaw) || descRaw);
    if (!title || !link) continue;
    if (GNEWS_RE.test(link) || BING_NEWS_RE.test(src.url || '')) {
      title = title.replace(/\s+-\s+[^-]{2,40}$/, '');
    }
    const dateStr = text(n.pubDate) || text(n.published) || text(n.updated) || text(n['dc:date']);
    const d = dateStr ? new Date(dateStr) : null;
    const rawHtml = String(text(descRaw) || descRaw || '');
    const full = stripHtml(rawHtml).length >= MIN_CONTENT ? rawHtml.slice(0, MAX_ITEM_HTML) : '';
    out.push({
      t: title, l: link,
      s: stripHtml(text(descRaw) || descRaw).slice(0, 300),
      d: d && !isNaN(d) ? d.toISOString() : null,
      i: src.id, n: src.name, c: src.color, _full: full
    });
  }
  return out;
}

async function fetchText(url, { timeout = TIMEOUT_MS, headers = {}, retries = FETCH_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, {
        signal: ctl.signal, redirect: 'follow',
        headers: {
          'user-agent': UA,
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          ...headers
        }
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries && isTransientError(e)) {
        await sleep(400 * (attempt + 1) + Math.random() * 200);
        continue;
      }
      throw e;
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

function readPrevContent() {
  const prev = new Map();
  if (!existsSync(CONTENT_DIR)) return prev;
  for (const f of readdirSync(CONTENT_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const obj = JSON.parse(readFileSync(`${CONTENT_DIR}/${f}`, 'utf8'));
      for (const [link, html] of Object.entries(obj)) prev.set(link, html);
    } catch {}
  }
  return prev;
}

async function fetchPage(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'vi,en;q=0.9'
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (type && !/html|xml|text\/plain/i.test(type)) throw new Error('không phải HTML');
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_PAGE_BYTES) throw new Error('trang quá nặng');
    const body = await r.text();
    if (body.length > MAX_PAGE_BYTES) throw new Error('trang quá nặng');
    return body;
  } finally { clearTimeout(timer); }
}

function readable(html, url) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url, virtualConsole: vc });
  try {
    const art = new Readability(dom.window.document, { charThreshold: 300 }).parse();
    if (!art || !art.content) return '';
    if ((art.textContent || '').trim().length < 400) return '';
    return art.content.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, MAX_ITEM_HTML);
  } catch { return ''; }
  finally { dom.window.close(); }
}

async function resolveGoogleLink(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'vi,en;q=0.9' }
  });
  if (r.url && !GNEWS_RE.test(r.url)) return r.url;
  const html = await r.text();
  const pats = [
    /data-n-au="([^"]+)"/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i,
    /<link[^>]+rel=["']canonical["'][^>]+href="(https?:\/\/(?!news\.google)[^"]+)"/i,
    /href="(https?:\/\/(?!news\.google|accounts\.google|policies\.google|support\.google|www\.google)[^"]+)"/i
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (m && m[1]) {
      const u = m[1].replace(/&amp;/g, '&');
      if (!GNEWS_RE.test(u)) return u;
    }
  }
  return null;
}

async function extractMissing(items, prev) {
  const todo = [];
  let reused = 0;
  for (const it of items) {
    if (it._full) continue;
    const old = prev.get(it.l);
    if (old) { it._full = old; reused++; continue; }
    todo.push(it);
  }
  if (!EXTRACT || !todo.length) return { tried: 0, ok: 0, reused, fail: 0, byError: {} };

  const perSrc = new Map();
  for (const it of todo) {
    if (!perSrc.has(it.i)) perSrc.set(it.i, []);
    const arr = perSrc.get(it.i);
    if (arr.length < EXTRACT_PER_SRC) arr.push(it);
  }
  const queue = [];
  for (let round = 0; queue.length < EXTRACT_MAX; round++) {
    let added = false;
    for (const arr of perSrc.values()) {
      if (!arr[round]) continue;
      queue.push(arr[round]); added = true;
      if (queue.length >= EXTRACT_MAX) break;
    }
    if (!added) break;
  }

  console.log(
    `\nBóc nội dung trang gốc: ${queue.length} bài mới từ ${perSrc.size} nguồn` +
    (todo.length > queue.length ? ` (còn ${todo.length - queue.length} bài để lần sau)` : '')
  );

  let ok = 0, fail = 0, gnTried = 0, gnOk = 0;
  const byError = {};
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        if (GNEWS_RE.test(it.l)) {
          gnTried++;
          const real = await resolveGoogleLink(it.l);
          if (real) { it.l = real; gnOk++; }
          else { fail++; byError['google-link'] = (byError['google-link'] || 0) + 1; continue; }
        }
        const content = readable(await fetchPage(it.l), it.l);
        if (content) { it._full = content; ok++; }
        else { fail++; byError['empty-readability'] = (byError['empty-readability'] || 0) + 1; }
      } catch (e) {
        fail++;
        const key = String(e.message || e).slice(0, 80);
        byError[key] = (byError[key] || 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONC, Math.max(queue.length, 1)) }, () => worker()));
  if (gnTried) console.log(`  đổi link Google News → báo gốc: ${gnOk}/${gnTried}`);
  if (fail) {
    const top = Object.entries(byError).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}×${v}`).join(', ');
    console.log(`  bóc lỗi: ${fail} (${top})`);
  }
  return { tried: todo.length, ok, reused, fail, byError };
}

const chuanHoa = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
const laGoogle = u => GNEWS_RE.test(u || '');

function gopVao(giu, bo) {
  giu.a = giu.a || [];
  if (giu.i !== bo.i && !giu.a.includes(bo.i)) giu.a.push(bo.i);
  for (const id of bo.a || []) if (id !== giu.i && !giu.a.includes(id)) giu.a.push(id);
  if (!giu._full && bo._full) giu._full = bo._full;
  if (!giu.s && bo.s) giu.s = bo.s;
}

function dedupeItems(all) {
  const conLai = new Set(), theoLink = new Map(), theoTieuDe = new Map();
  for (const it of all) {
    it.a = it.a || [];
    const cu = theoLink.get(it.l);
    if (cu) { gopVao(cu, it); continue; }
    const key = chuanHoa(it.t);
    const cuT = key && theoTieuDe.get(key);
    if (cuT) {
      if (laGoogle(cuT.l) && !laGoogle(it.l)) {
        gopVao(it, cuT); conLai.delete(cuT); theoLink.delete(cuT.l);
        conLai.add(it); theoLink.set(it.l, it); theoTieuDe.set(key, it);
      } else gopVao(cuT, it);
      continue;
    }
    conLai.add(it); theoLink.set(it.l, it);
    if (key) theoTieuDe.set(key, it);
  }
  return [...conLai];
}

function keepBalanced(items) {
  const sorted = [...items].sort((x, y) => new Date(y.d || 0) - new Date(x.d || 0));
  const perSource = new Map();
  for (const it of sorted) {
    if (!perSource.has(it.i)) perSource.set(it.i, []);
    perSource.get(it.i).push(it);
  }
  const kept = new Set();
  for (let round = 0; round < KEEP_PER_SOURCE && kept.size < MAX_ITEMS; round++) {
    for (const list of perSource.values()) {
      if (!list[round]) continue;
      kept.add(list[round]);
      if (kept.size >= MAX_ITEMS) break;
    }
  }
  for (const it of sorted) {
    if (kept.size >= MAX_ITEMS) break;
    kept.add(it);
  }
  return sorted.filter(it => kept.has(it));
}

const sources = readSources(readFileSync(HTML_FILE, 'utf8'));
console.log(`Có ${sources.length} nguồn cần lấy`);

const status = {};
const all = [];
const queue = sources.slice();

async function feedWorker() {
  while (queue.length) {
    const s = queue.shift();
    try {
      const xml = await fetchText(s.url);
      if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('không phải RSS/Atom');
      const items = parseFeed(xml, s);
      if (!items.length) {
        status[s.id] = { count: 0, error: 'feed rỗng' };
        console.log(`  ○ ${s.name}: 0 bài (feed rỗng)`);
        continue;
      }
      all.push(...items);
      status[s.id] = { count: items.length, error: null };
      console.log(`  ✓ ${s.name}: ${items.length} bài`);
    } catch (e) {
      status[s.id] = { count: 0, error: String(e.message || e) };
      console.log(`  ✗ ${s.name}: ${e.message || e}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(queue.length, 1)) }, () => feedWorker()));

let items = dedupeItems(all);
items = keepBalanced(items);

const prevContent = readPrevContent();
const ex = await extractMissing(items, prevContent);

{
  const m2 = new Map();
  for (const it of items) {
    const old = m2.get(it.l);
    if (!old) { m2.set(it.l, it); continue; }
    old.a = old.a || [];
    if (old.i !== it.i && !old.a.includes(it.i)) old.a.push(it.i);
    if (!old._full && it._full) old._full = it._full;
    if (!old.s && it.s) old.s = it.s;
  }
  const truoc = items.length;
  items = [...m2.values()];
  if (truoc !== items.length) console.log(`  gộp thêm ${truoc - items.length} bài trùng sau khi đổi link`);
}

rmSync(CONTENT_DIR, { recursive: true, force: true });
mkdirSync(CONTENT_DIR, { recursive: true });

const shards = new Map();
for (const it of items) {
  const full = it._full;
  delete it._full;
  if (!full) continue;
  if (!shards.has(it.i)) shards.set(it.i, {});
  const shard = shards.get(it.i);
  if (JSON.stringify(shard).length + full.length > MAX_SHARD) continue;
  shard[it.l] = full;
  it.f = 1;
}

let shardFiles = 0, shardBytes = 0;
for (const [id, shard] of shards) {
  if (!Object.keys(shard).length) continue;
  const body = JSON.stringify(shard);
  writeAtomic(`${CONTENT_DIR}/${id}.json`, body);
  shardFiles++; shardBytes += body.length;
}

writeAtomic(OUT_FILE, JSON.stringify({ v: SCHEMA_VERSION, at: Date.now(), sources: status, items }));

const withFull = items.filter(i => i.f).length;
console.log(
  `Toàn văn dựng sẵn: ${withFull}/${items.length} bài, ${shardFiles} file, ${Math.round(shardBytes / 1024)} KB` +
  (EXTRACT ? ` (bóc mới ${ex.ok}, dùng lại ${ex.reused}, lỗi ${ex.fail || 0})` : ' (bỏ qua bước bóc)')
);

const okN = Object.values(status).filter(v => !v.error).length;
const empty = Object.values(status).filter(v => v.error === 'feed rỗng').length;
const errN = Object.values(status).filter(v => v.error && v.error !== 'feed rỗng').length;
console.log(
  `\nXong: ${items.length} bài từ ${okN}/${sources.length} nguồn` +
  (empty ? `, ${empty} feed rỗng` : '') + (errN ? `, ${errN} lỗi` : '') + ` → ${OUT_FILE}`
);

if (!items.length) {
  console.error('Không lấy được bài nào — dừng để không ghi đè data.json cũ bằng file rỗng.');
  process.exit(1);
}

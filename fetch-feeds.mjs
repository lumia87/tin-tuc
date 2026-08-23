#!/usr/bin/env node
/* Gom RSS phía máy chủ rồi ghi ra data.json.
   Chạy trên GitHub Actions nên KHÔNG dính CORS -> gọi thẳng feed, không qua cầu nối.
   Danh sách nguồn đọc trực tiếp từ mảng SOURCES trong index.html, để bạn chỉ phải
   thêm/bớt nguồn ở một chỗ duy nhất.

   Dùng:  node fetch-feeds.mjs [index.html] [data.json]
*/
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

const HTML_FILE = process.argv[2] || 'index.html';
const OUT_FILE  = process.argv[3] || 'data.json';

const MAX_PER_SOURCE = 25;
const MAX_ITEMS      = 900;
const CONTENT_DIR    = 'content';   // toàn văn tách riêng theo từng nguồn, trang chỉ tải khi mở bài
const MIN_CONTENT    = 900;         // ngắn hơn thì coi như chỉ là tóm tắt, không đáng lưu
const MAX_ITEM_HTML  = 60 * 1024;   // trần mỗi bài
const MAX_SHARD      = 1500 * 1024; // trần mỗi file nguồn

/* Bóc nội dung trang gốc cho những bài feed không kèm toàn văn (VD bài từ Google News).
   Chạy trên máy GitHub nên không vướng CORS. Bài đã bóc lần trước được dùng lại,
   nên mỗi lần chạy chỉ phải tải những bài thật sự mới. Tắt bằng EXTRACT=0. */
const EXTRACT        = process.env.EXTRACT !== '0';
const EXTRACT_MAX    = Number(process.env.EXTRACT_MAX || 250);  // số bài mới tối đa mỗi lần chạy
const EXTRACT_CONC   = 6;
const PAGE_TIMEOUT   = 15000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
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

    // nhiều feed gửi kèm toàn văn -> giữ lại để trang khỏi phải tải trang gốc lúc đọc
    const rawHtml = String(text(descRaw) || descRaw || '');
    const full = stripHtml(rawHtml).length >= MIN_CONTENT ? rawHtml.slice(0, MAX_ITEM_HTML) : '';

    out.push({
      t: title,
      l: link,
      s: stripHtml(text(descRaw) || descRaw).slice(0, 300),
      d: d && !isNaN(d) ? d.toISOString() : null,
      i: src.id, n: src.name, c: src.color,
      _full: full
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

/* ---------- bóc nội dung trang gốc ---------- */

/* đọc lại toàn văn đã bóc ở lần chạy trước để khỏi tải lại */
function readPrevContent(){
  const prev = new Map();
  if (!existsSync(CONTENT_DIR)) return prev;
  for (const f of readdirSync(CONTENT_DIR)){
    if (!f.endsWith('.json')) continue;
    try{
      const obj = JSON.parse(readFileSync(`${CONTENT_DIR}/${f}`, 'utf8'));
      for (const [link, html] of Object.entries(obj)) prev.set(link, html);
    }catch{}
  }
  return prev;
}

async function fetchPage(url){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_TIMEOUT);
  try{
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (!/html/i.test(type)) throw new Error('không phải HTML');
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_PAGE_BYTES) throw new Error('trang quá nặng');
    const body = await r.text();
    if (body.length > MAX_PAGE_BYTES) throw new Error('trang quá nặng');
    return body;
  } finally { clearTimeout(timer); }
}

function readable(html, url){
  const vc = new VirtualConsole();          // nuốt log lỗi CSS/JS của trang, khỏi rác nhật ký
  const dom = new JSDOM(html, { url, virtualConsole: vc });
  try{
    const art = new Readability(dom.window.document, { charThreshold: 300 }).parse();
    if (!art || !art.content) return '';
    if ((art.textContent || '').trim().length < 400) return '';
    return art.content.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, MAX_ITEM_HTML);
  }catch{ return ''; }
  finally { dom.window.close(); }
}

async function extractMissing(items, prev){
  const todo = [];
  for (const it of items){
    if (it._full) continue;
    const old = prev.get(it.l);
    if (old){ it._full = old; continue; }          // đã bóc lần trước -> dùng lại
    todo.push(it);
  }
  if (!EXTRACT || !todo.length) return { tried:0, ok:0, reused: items.filter(i => i._full).length };

  const queue = todo.slice(0, EXTRACT_MAX);
  console.log(`\nBóc nội dung trang gốc: ${queue.length} bài mới` +
              (todo.length > queue.length ? ` (còn ${todo.length - queue.length} bài để lần sau)` : ''));
  let ok = 0;
  const worker = async () => {
    while (queue.length){
      const it = queue.shift();
      try{
        const content = readable(await fetchPage(it.l), it.l);
        if (content){ it._full = content; ok++; }
      }catch{}
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONC, queue.length) }, worker));
  return { tried: todo.length, ok, reused: items.filter(i => i._full).length - ok };
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
  // Cùng một bài có thể tới từ hai feed: bản của báo gốc kèm toàn văn, bản qua
  // Google News thì không. Giữ lại bản nào có toàn văn, đừng để bản rỗng thắng.
  if (!old._full && it._full) old._full = it._full;
  if (!old.s && it.s) old.s = it.s;
}
const items = [...map.values()]
  .sort((x, y) => new Date(y.d || 0) - new Date(x.d || 0))
  .slice(0, MAX_ITEMS);

/* Bài nào feed không kèm toàn văn thì tải trang gốc rồi bóc phần thân bài.
   Đọc lại kết quả lần trước TRƯỚC khi xoá thư mục, để chỉ tải bài thật sự mới. */
const prevContent = readPrevContent();
const ex = await extractMissing(items, prevContent);

/* Tách toàn văn ra file riêng theo từng nguồn: content/<id>.json
   Trang chỉ tải file của nguồn nào khi bạn mở bài của nguồn đó, nên data.json
   vẫn nhẹ mà mở bài lại không phải đi lấy trang gốc. */
rmSync(CONTENT_DIR, { recursive: true, force: true });
mkdirSync(CONTENT_DIR, { recursive: true });

const shards = new Map();
for (const it of items){
  const full = it._full;
  delete it._full;
  if (!full) continue;
  if (!shards.has(it.i)) shards.set(it.i, {});
  const shard = shards.get(it.i);
  const size = JSON.stringify(shard).length;
  if (size + full.length > MAX_SHARD) continue;      // nguồn nào quá nặng thì dừng ở đó
  shard[it.l] = full;
  it.f = 1;                                          // đánh dấu: có sẵn toàn văn
}
let shardFiles = 0, shardBytes = 0;
for (const [id, shard] of shards){
  if (!Object.keys(shard).length) continue;
  const body = JSON.stringify(shard);
  writeFileSync(`${CONTENT_DIR}/${id}.json`, body);
  shardFiles++; shardBytes += body.length;
}

writeFileSync(OUT_FILE, JSON.stringify({ at: Date.now(), sources: status, items }));
console.log(`Toàn văn dựng sẵn: ${items.filter(i => i.f).length}/${items.length} bài, ` +
            `${shardFiles} file, ${Math.round(shardBytes / 1024)} KB` +
            (EXTRACT ? ` (bóc mới ${ex.ok}, dùng lại ${ex.reused})` : ' (bỏ qua bước bóc)'));

const ok = Object.values(status).filter(v => !v.error).length;
console.log(`\nXong: ${items.length} bài từ ${ok}/${sources.length} nguồn -> ${OUT_FILE}`);
if (!items.length){
  console.error('Không lấy được bài nào — dừng để không ghi đè data.json cũ bằng file rỗng.');
  process.exit(1);
}

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
const MAX_ITEMS      = 1200;
const KEEP_PER_SOURCE = 12;         // mỗi nguồn chắc chắn giữ được bấy nhiêu bài mới nhất
const CONTENT_DIR    = 'content';   // toàn văn tách riêng theo từng nguồn, trang chỉ tải khi mở bài
const MIN_CONTENT    = 900;         // ngắn hơn thì coi như chỉ là tóm tắt, không đáng lưu
const MAX_ITEM_HTML  = 60 * 1024;   // trần mỗi bài
const MAX_SHARD      = 1500 * 1024; // trần mỗi file nguồn

/* Bóc nội dung trang gốc cho những bài feed không kèm toàn văn (VD bài từ Google News).
   Chạy trên máy GitHub nên không vướng CORS. Bài đã bóc lần trước được dùng lại,
   nên mỗi lần chạy chỉ phải tải những bài thật sự mới. Tắt bằng EXTRACT=0. */
const EXTRACT        = process.env.EXTRACT !== '0';
const EXTRACT_MAX    = Number(process.env.EXTRACT_MAX || 600);  // số bài mới tối đa mỗi lần chạy
const EXTRACT_PER_SRC = Number(process.env.EXTRACT_PER_SRC || 15); // trần mỗi nguồn, để nguồn nào cũng có phần
const EXTRACT_CONC   = 8;
const PAGE_TIMEOUT   = 15000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS     = 20000;
const CONCURRENCY    = 8;
const UA = 'Mozilla/5.0 (compatible; tin-tuc-reader/1.0; +https://github.com)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

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
      headers: {
        // nhiều báo chặn thẳng các user-agent lạ, nên khai báo như trình duyệt thật
        'user-agent': BROWSER_UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

/* Link của Google News là dạng news.google.com/rss/articles/CBMi… — một mã đóng,
   không giải cục bộ được (thử base64 chỉ ra chuỗi token, không phải URL).
   Cách duy nhất là gọi vào rồi lần theo dấu vết trong trang trả về. */
const GNEWS_RE = /^https?:\/\/news\.google\.com\//i;

async function resolveGoogleLink(url){
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'vi,en;q=0.9' }
  });
  if (r.url && !GNEWS_RE.test(r.url)) return r.url;        // Google tự chuyển hướng thẳng
  const html = await r.text();
  const pats = [
    /data-n-au="([^"]+)"/i,                                 // thuộc tính Google hay dùng
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i,
    /<link[^>]+rel=["']canonical["'][^>]+href="(https?:\/\/(?!news\.google)[^"]+)"/i,
    /href="(https?:\/\/(?!news\.google|accounts\.google|policies\.google|support\.google|www\.google)[^"]+)"/i
  ];
  for (const re of pats){
    const m = html.match(re);
    if (m && m[1]){
      const u = m[1].replace(/&amp;/g, '&');
      if (!GNEWS_RE.test(u)) return u;
    }
  }
  return null;
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

  /* Xếp hàng luân phiên giữa các nguồn. Nếu cứ lấy theo thứ tự thời gian thì vài nguồn
     đăng dày sẽ ăn hết ngân sách, còn nguồn thưa bài (VD các luồng theo tên người)
     không bao giờ tới lượt — đúng cái đã xảy ra ở lần chạy trước. */
  const perSrc = new Map();
  for (const it of todo){
    if (!perSrc.has(it.i)) perSrc.set(it.i, []);
    const arr = perSrc.get(it.i);
    if (arr.length < EXTRACT_PER_SRC) arr.push(it);
  }
  const queue = [];
  for (let round = 0; queue.length < EXTRACT_MAX; round++){
    let added = false;
    for (const arr of perSrc.values()){
      if (!arr[round]) continue;
      queue.push(arr[round]); added = true;
      if (queue.length >= EXTRACT_MAX) break;
    }
    if (!added) break;
  }

  console.log(`\nBóc nội dung trang gốc: ${queue.length} bài mới từ ${perSrc.size} nguồn` +
              (todo.length > queue.length ? ` (còn ${todo.length - queue.length} bài để lần sau)` : ''));
  let ok = 0, gnTried = 0, gnOk = 0;
  const worker = async () => {
    while (queue.length){
      const it = queue.shift();
      try{
        if (GNEWS_RE.test(it.l)){          // đổi link Google News sang link báo gốc trước đã
          gnTried++;
          const real = await resolveGoogleLink(it.l);
          if (real){ it.l = real; gnOk++; } else continue;
        }
        const content = readable(await fetchPage(it.l), it.l);
        if (content){ it._full = content; ok++; }
      }catch{}
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONC, queue.length) }, worker));
  if (gnTried) console.log(`  đổi link Google News sang báo gốc: ${gnOk}/${gnTried}`);
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
/* Cắt bớt cho gọn, nhưng phải bảo đảm nguồn nào cũng có mặt.
   Nếu chỉ cắt theo thời gian thì nguồn nào bài cũ hơn — điển hình là các luồng
   Google News dùng when:30d — sẽ bị loại sạch dù vẫn lấy được bài. */
const sorted = [...map.values()].sort((x, y) => new Date(y.d || 0) - new Date(x.d || 0));

const perSource = new Map();
for (const it of sorted){                       // gom theo nguồn, vẫn giữ thứ tự mới -> cũ
  if (!perSource.has(it.i)) perSource.set(it.i, []);
  perSource.get(it.i).push(it);
}
const kept = new Set();
// vòng 1: luân phiên từng nguồn một bài, để nguồn nào cũng có mặt trước khi ai đó lấy phần thứ hai
for (let round = 0; round < KEEP_PER_SOURCE && kept.size < MAX_ITEMS; round++){
  for (const list of perSource.values()){
    if (!list[round]) continue;
    kept.add(list[round]);
    if (kept.size >= MAX_ITEMS) break;
  }
}
for (const it of sorted){                       // vòng 2: lấp chỗ trống theo thời gian
  if (kept.size >= MAX_ITEMS) break;
  kept.add(it);
}
let items = sorted.filter(it => kept.has(it));

/* Bài nào feed không kèm toàn văn thì tải trang gốc rồi bóc phần thân bài.
   Đọc lại kết quả lần trước TRƯỚC khi xoá thư mục, để chỉ tải bài thật sự mới. */
const prevContent = readPrevContent();
const ex = await extractMissing(items, prevContent);

/* Đổi link xong có thể sinh trùng mới: bài qua Google News giờ cùng link với bài
   lấy thẳng từ feed báo gốc. Gộp lại một lần nữa, giữ bản có toàn văn. */
{
  const m2 = new Map();
  for (const it of items){
    const old = m2.get(it.l);
    if (!old){ m2.set(it.l, it); continue; }
    old.a = old.a || [];
    if (old.i !== it.i && !old.a.includes(it.i)) old.a.push(it.i);
    if (!old._full && it._full) old._full = it._full;
  }
  const truoc = items.length;
  items = [...m2.values()];
  if (truoc !== items.length) console.log(`  gộp thêm ${truoc - items.length} bài trùng sau khi đổi link`);
}

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

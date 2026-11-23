'use strict';
/*
 * His&Her Lucky Spin — เซิร์ฟเวอร์ (Node.js ไม่ต้องติดตั้ง framework เพิ่ม)
 *
 *   หน้าเว็บ : /  (กรอกรหัส)   /game.html (วงล้อ)   /admin (หลังบ้าน)
 *   API     : GET /api/check/:id   GET /api/stock   POST /api/spin {memberId}
 *   หลังบ้าน : /admin/login  /admin  /admin/export.csv
 *
 * ตั้งค่าผ่าน environment หรือไฟล์ .env ข้างไฟล์นี้
 *   ADMIN_PASSWORD  (จำเป็น)  รหัสผ่านหลังบ้าน
 *   TABLE_NAME      ชื่อตาราง DynamoDB (ไม่ตั้ง = เก็บในหน่วยความจำ ใช้ทดสอบเท่านั้น)
 *   AWS_REGION      ค่าเริ่มต้น ap-southeast-2
 *   PORT            ค่าเริ่มต้น 3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ── โหลด .env (ถ้ามี) ── */
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { createStore, OutOfStock, AlreadyPlayed, NotFound } = require('./store');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'event.config.json'), 'utf8'));
const store = createStore(CFG.prizes);   /* event.config.json ใช้เป็นรายการตั้งต้นครั้งแรกเท่านั้น หลังจากนั้นแก้ที่หลังบ้าน */

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) console.warn('⚠️  ยังไม่ได้ตั้ง ADMIN_PASSWORD — หลังบ้านจะเข้าไม่ได้');
const SECRET = crypto.createHash('sha256').update('luckyspin:' + ADMIN_PASSWORD).digest();
const MEMBER_RE = CFG.memberIdPattern ? new RegExp(CFG.memberIdPattern) : null;

/* ════════════════ TEMPLATES ════════════════ */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badgeInner = (CFG.badgeLines || []).map(esc).join('<br>').replace(/ /g, '&nbsp;');
function themeFile(suffix) {
  if (!CFG.theme) return '';
  const f = path.join(__dirname, 'views', `theme-${CFG.theme.replace(/[^\w-]/g, '')}.${suffix}`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
const hasFile = (...parts) => fs.existsSync(path.join(__dirname, 'public', ...parts));
/* ภาพของแต่ละรางวัล: รางวัลตั้งต้นใช้ไฟล์ใน public/prizes, รางวัลที่อัปโหลดจากหลังบ้านใช้ /img/<id> */
function prizeImages(p) {
  if (p.imgVer) { const u = `img/${encodeURIComponent(p.id)}?v=${p.imgVer}`; return { file: u, wheel: u, logo: '' }; }
  if (p.file) return {
    file: 'prizes/' + p.file,
    wheel: hasFile('prizes', 'wheel', p.file) ? 'prizes/wheel/' + p.file : 'prizes/' + p.file,
    logo: hasFile('prizes', 'logo', p.file) ? 'prizes/logo/' + p.file : '',
  };
  return { file: '', wheel: '', logo: '' };
}
const vars = {
  FILTER_CSS: CFG.saturation != null && CFG.saturation !== 1 ? `html { filter: saturate(${Number(CFG.saturation)}); }` : '',
  PAGE_TITLE: esc(CFG.pageTitle),
  TITLE_MAIN: esc(CFG.titleMain),
  TITLE_SUB: esc(CFG.titleSub),
  BADGE_INDEX: badgeInner ? `<span class="ev-badge">${badgeInner}</span>` : '',
  BADGE_GAME: badgeInner ? `<span class="badge-30">${badgeInner}</span>` : '',
  TAGLINE: esc(CFG.tagline || '').replace(/\n/g, '<br>'),
  DATE_TEXT: esc(CFG.dateText),
  VENUE_TEXT: esc((CFG.venueLines || []).join(' ')),
  EVENT_INFO: [CFG.dateText, (CFG.venueLines || []).join(' ')].filter(Boolean).map(esc).join('&ensp;|&ensp;'),
  DATE_NUM: esc(CFG.dateNum),
  DATE_MONTH: esc(CFG.dateMonth),
  VENUE_HTML: (CFG.venueLines || []).map(esc).join('<br>'),
  RESULT_MSG: esc(CFG.resultMessage || 'คุณได้รับสินค้าพิเศษ! 🎁'),
  THEME_HEAD: themeFile('head.html'),
  THEME_DECOR: themeFile('decor.html'),
  THEME_CSS: CFG.theme ? fs.readFileSync(path.join(__dirname, 'views', `theme-${CFG.theme.replace(/[^\w-]/g, '')}.css`), 'utf8') : '',
};
const TEMPLATES = Object.fromEntries(['index.html', 'game.html'].map(f => [f, fs.readFileSync(path.join(__dirname, 'views', f), 'utf8')]));
/* สร้างหน้าใหม่ทุกครั้ง เพราะรายการรางวัลแก้ได้จากหลังบ้าน */
async function render(file) {
  const prizes = await store.getPrizes();
  const v = {
    ...vars,
    PRIZE_COUNT: String(prizes.length),
    PRIZE_GRID: prizes.map(p => `<figure class="reg-prize"><img src="${esc(prizeImages(p).wheel)}" alt="${esc(p.name)}" loading="lazy"></figure>`).join(''),
    PRODUCTS_JSON: JSON.stringify(prizes.map(p => ({ ...prizeImages(p), name: p.name }))).replace(/</g, '\\u003c'),
  };
  return TEMPLATES[file].replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? v[k] : m));
}
const stockMap = prizes => Object.fromEntries(prizes.map(p => [p.name, p.qty]));

/* ════════════════ HELPERS ════════════════ */
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.css': 'text/css', '.js': 'text/javascript' };
function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
function readBody(req, limit = 1e5) {
  return new Promise((ok, bad) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > limit) { bad(new Error('too_large')); req.destroy(); } });
    req.on('end', () => ok(b)); req.on('error', bad);
  });
}
const cleanId = s => String(s || '').trim().slice(0, 30);
function validId(id) { return id && (!MEMBER_RE || MEMBER_RE.test(id)); }

/* ── admin session (cookie ลงลายเซ็น อายุ 12 ชม.) ── */
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeSession() { const exp = String(Date.now() + 12 * 3600e3); return exp + '.' + sign(exp); }
function isAdmin(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ls_admin=([^;]+)/);
  if (!m || !ADMIN_PASSWORD) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function samePassword(p) {
  const a = crypto.createHash('sha256').update(String(p)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return ADMIN_PASSWORD && crypto.timingSafeEqual(a, b);
}
const thaiTime = iso => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });

/* ════════════════ ADMIN PAGES ════════════════ */
const ADMIN_CSS = `*{box-sizing:border-box}body{margin:0;background:#f0f6ff;font-family:'Kanit',sans-serif;color:#222}
.wrap{max-width:1000px;margin:0 auto;padding:24px}h1{color:#C9200A;margin:0 0 4px}h2{margin:28px 0 10px;font-size:1.2em}
.sub{color:#666;margin-bottom:18px}.cards{display:flex;gap:12px;flex-wrap:wrap}
.card{background:#fff;border-radius:14px;padding:14px 18px;box-shadow:0 4px 14px rgba(0,0,0,.07);min-width:160px}
.card b{display:block;font-size:1.8em;color:#C9200A}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,.07)}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #eee;font-size:.95em}th{background:#fff4f1;color:#a81500}
input[type=number],input[type=text]{width:90px;padding:6px 8px;border:2px solid #ddd;border-radius:8px;font-family:inherit}
button,.btn{border:0;border-radius:20px;padding:7px 16px;background:linear-gradient(135deg,#ff5030,#C9200A);color:#fff;font-family:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
.ghost{background:#fff;color:#C9200A;border:2px solid #C9200A}.danger{background:#555}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.zero{color:#bbb}.msg{background:#e8fff0;border:1px solid #9ad7ad;padding:8px 12px;border-radius:10px;margin:10px 0}`;
const FONT = `<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;700;900&display=swap" rel="stylesheet">`;

function loginPage(err = '') {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login - ${esc(CFG.pageTitle)}</title>${FONT}<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f6ff;font-family:'Kanit',sans-serif;padding:24px}
.box{width:min(420px,100%);background:#fff;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
h1{margin:0 0 18px;color:#C9200A;font-size:1.5em}label{display:block;font-weight:700;margin-bottom:8px;color:#333}
input{width:100%;padding:12px 14px;border:2px solid #ddd;border-radius:10px;font-family:'Kanit',sans-serif;font-size:1em}input:focus{outline:none;border-color:#C9200A}
button{width:100%;margin-top:16px;border:0;border-radius:30px;padding:12px 18px;background:linear-gradient(135deg,#ff5030,#C9200A);color:#fff;font-family:'Kanit',sans-serif;font-weight:900;font-size:1em;cursor:pointer}
.err{min-height:22px;color:#C9200A;font-weight:700;margin-top:10px}</style></head><body>
<form class="box" method="post" action="/admin/login"><h1>ระบบหลังบ้าน Lucky Spin</h1>
<label for="password">รหัสผ่าน</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<div class="err">${esc(err)}</div><button type="submit">เข้าสู่ระบบ</button></form></body></html>`;
}

async function dashboard(msg = '', isErr = false) {
  const [prizes, plays] = await Promise.all([store.getPrizes(), store.listPlays()]);
  const given = {}; plays.forEach(p => { given[p.product] = (given[p.product] || 0) + 1; });
  const remain = prizes.reduce((s, p) => s + p.qty, 0);
  const thumb = p => { const w = prizeImages(p).wheel; return w ? `<img class="th" src="/${esc(w)}" alt="">` : '<div class="th none">ไม่มีรูป</div>'; };
  const rows = prizes.map(p => `<tr class="${p.qty > 0 ? '' : 'zero'}">
<td>${thumb(p)}</td>
<td colspan="3"><form method="post" action="/admin/prize/save" class="row pform">
  <input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="img" class="imgdata">
  <input type="text" name="name" value="${esc(p.name)}" maxlength="80" required class="nm">
  <span class="given">แจกแล้ว ${given[p.name] || 0}</span>
  <label class="lbl">คงเหลือ <input type="number" name="qty" min="0" max="100000" value="${p.qty}" required></label>
  <label class="btn ghost file">เปลี่ยนรูป<input type="file" accept="image/png,image/jpeg,image/webp" class="imgfile" hidden></label>
  <button>บันทึก</button>
</form></td>
<td><form method="post" action="/admin/prize/delete" onsubmit="return confirm('ลบ &quot;${esc(p.name)}&quot; ออกจากวงล้อ?')"><input type="hidden" name="id" value="${esc(p.id)}"><button class="danger">ลบ</button></form></td>
</tr>`).join('');
  const recent = plays.slice(-50).reverse().map(p => `<tr><td>${thaiTime(p.at)}</td><td>${esc(p.memberId)}</td><td>${esc(p.product)}</td>
<td><form method="post" action="/admin/delete-play" onsubmit="return confirm('ลบรายการนี้? (สต็อกจะไม่ถูกคืน)')"><input type="hidden" name="memberId" value="${esc(p.memberId)}"><button class="ghost">ลบ</button></form></td></tr>`).join('');
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>หลังบ้าน - ${esc(CFG.pageTitle)}</title>${FONT}<style>${ADMIN_CSS}
.th{width:64px;height:64px;object-fit:contain;background:#f4f4fa;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:.7em;color:#999}
.pform .nm{width:min(320px,100%)}.pform input[type=number]{width:90px}.given{color:#666;font-size:.9em;min-width:84px}
.lbl{display:flex;gap:6px;align-items:center;font-size:.9em}.file{cursor:pointer;padding:6px 12px}.file.picked{background:#e8fff0;border-color:#2a9d55;color:#2a9d55}
.add{background:#fff;border-radius:14px;padding:16px;box-shadow:0 4px 14px rgba(0,0,0,.07)}.add .preview{width:80px;height:80px;object-fit:contain;background:#f4f4fa;border-radius:10px}
.msg.err{background:#fff0f0;border-color:#e99}input[type=text].nm,.add input[type=text]{width:260px;padding:6px 8px;border:2px solid #ddd;border-radius:8px;font-family:inherit}
</style></head><body><div class="wrap">
<div class="row" style="justify-content:space-between"><div><h1>Lucky Spin — หลังบ้าน</h1><div class="sub">${esc(CFG.pageTitle)} · ${esc(CFG.dateText)} · ที่เก็บข้อมูล: ${store.kind}</div></div>
<div class="row"><a class="btn" href="/admin/export.csv">⬇ Export CSV</a><a class="btn ghost" href="/admin">รีเฟรช</a><a class="btn danger" href="/admin/logout">ออกจากระบบ</a></div></div>
${msg ? `<div class="msg${isErr ? ' err' : ''}">${esc(msg)}</div>` : ''}
<div class="cards"><div class="card">ผู้เล่นทั้งหมด<b>${plays.length}</b></div><div class="card">รางวัลคงเหลือรวม<b>${remain}</b></div>
<div class="card">รางวัลที่ยังมีของ<b>${prizes.filter(p => p.qty > 0).length}/${prizes.length}</b></div></div>

<h2>รางวัลบนวงล้อ</h2>
<p class="sub">แก้ชื่อ/จำนวนคงเหลือ แล้วกด "บันทึก" ทีละแถว · รางวัลที่คงเหลือ 0 จะหายจากวงล้ออัตโนมัติ · ของที่เหลือมากจะมีโอกาสออกมากกว่า</p>
<table>${rows || '<tr><td>ยังไม่มีรางวัล</td></tr>'}</table>

<h2>เพิ่มรางวัลใหม่</h2>
<form method="post" action="/admin/prize/add" class="row add pform">
  <input type="hidden" name="img" class="imgdata">
  <img class="preview" alt="" hidden>
  <input type="text" name="name" placeholder="ชื่อสินค้า" maxlength="80" required>
  <label class="lbl">จำนวน <input type="number" name="qty" min="0" max="100000" value="10" required></label>
  <label class="btn ghost file">เลือกรูป<input type="file" accept="image/png,image/jpeg,image/webp" class="imgfile" hidden></label>
  <button>+ เพิ่มรางวัล</button>
</form>
<p class="sub">รูปแนะนำ: PNG พื้นหลังโปร่งใส ภาพสินค้าชิ้นเดียว · ระบบจะย่อรูปให้อัตโนมัติ</p>

<h2>ผู้เล่นล่าสุด (50 รายการ)</h2><table><tr><th>เวลา</th><th>รหัสสมาชิก</th><th>รางวัลที่ได้</th><th></th></tr>${recent || '<tr><td colspan="4">ยังไม่มีผู้เล่น</td></tr>'}</table>
<h2>รีเซ็ตทั้งหมด</h2><form method="post" action="/admin/reset" class="row" onsubmit="return confirm('ลบผู้เล่นทั้งหมดและคืนจำนวนรางวัลเป็นค่าที่บันทึกล่าสุด?')">
<span>พิมพ์คำว่า RESET เพื่อยืนยัน (ลบประวัติผู้เล่นทั้งหมด + คืนจำนวนรางวัลเป็นค่าที่บันทึกล่าสุดของแต่ละรายการ)</span><input type="text" name="confirm" placeholder="RESET"><button class="danger">รีเซ็ต</button></form>
<p class="sub" style="margin-top:24px">แนะนำ: Export CSV เก็บไว้ก่อนรีเซ็ตทุกครั้ง</p></div>
<script>
/* ย่อรูปในเบราว์เซอร์ก่อนส่ง (ด้านยาวสุด 600px) */
function shrink(file){ return new Promise((ok,bad)=>{ const r=new FileReader(); r.onerror=bad; r.onload=()=>{ const im=new Image(); im.onerror=bad; im.onload=()=>{
  let s=Math.min(1,600/Math.max(im.width,im.height)); const c=document.createElement('canvas'); c.width=Math.round(im.width*s); c.height=Math.round(im.height*s);
  c.getContext('2d').drawImage(im,0,0,c.width,c.height); let d=c.toDataURL('image/webp',.85); if(!d.startsWith('data:image/webp')) d=c.toDataURL('image/png'); ok(d); }; im.src=r.result; }; r.readAsDataURL(file); }); }
document.querySelectorAll('.pform').forEach(f=>{
  const inp=f.querySelector('.imgfile'), hid=f.querySelector('.imgdata'), lab=inp.closest('label'), pv=f.querySelector('.preview');
  inp.addEventListener('change', async ()=>{ if(!inp.files[0]) return; lab.firstChild.textContent='กำลังย่อรูป…';
    try{ hid.value=await shrink(inp.files[0]); lab.firstChild.textContent='✓ '+inp.files[0].name.slice(0,18); lab.classList.add('picked'); if(pv){pv.src=hid.value;pv.hidden=false;} }
    catch(e){ lab.firstChild.textContent='รูปใช้ไม่ได้'; hid.value=''; } });
  f.addEventListener('submit', e=>{ if(f.action.endsWith('/add') && !hid.value){ e.preventDefault(); alert('กรุณาเลือกรูปสินค้า'); } });
});
</script></body></html>`;
}

async function validatePrizeForm(f) {
  const id = String(f.get('id') || '');
  const name = String(f.get('name') || '').trim().replace(/\s+/g, ' ');
  const qty = parseInt(f.get('qty'), 10);
  const img = String(f.get('img') || '');
  if (!name || name.length > 80) return { error: 'ชื่อสินค้าต้องมี 1–80 ตัวอักษร' };
  if (!Number.isInteger(qty) || qty < 0 || qty > 100000) return { error: 'จำนวนต้องเป็นตัวเลข 0–100000' };
  if (img) {
    const m = img.match(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
    if (!m) return { error: 'ไฟล์รูปไม่ถูกต้อง (ใช้ PNG, JPG หรือ WEBP)' };
    if (img.length > 380000) return { error: 'รูปใหญ่เกินไป ลองใช้รูปที่เล็กลง' };
  }
  const dup = (await store.getPrizes()).find(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
  if (dup) return { error: `มีรางวัลชื่อ "${name}" อยู่แล้ว` };
  return { id, name, qty, img };
}

/* ════════════════ ROUTER ════════════════ */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  /* หน้าเว็บผู้เล่น */
  if (p === '/' || p === '/index.html') return send(res, 200, await render('index.html'));
  if (p === '/game.html') return send(res, 200, await render('game.html'));
  if (p.startsWith('/img/')) {
    const data = await store.getImage(p.slice(5));
    const m = data && data.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!m) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, Buffer.from(m[2], 'base64'), m[1], { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  /* API */
  if (p.startsWith('/api/check/') && req.method === 'GET') {
    const id = cleanId(p.slice('/api/check/'.length));
    if (!validId(id)) return json(res, 200, { invalid: true, message: CFG.memberIdError });
    const play = await store.getPlay(id);
    return json(res, 200, play ? { played: true, product: play.product } : { played: false });
  }
  if (p === '/api/stock' && req.method === 'GET') return json(res, 200, stockMap(await store.getPrizes()));
  if (p === '/api/spin' && req.method === 'POST') {
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
    const id = cleanId(body.memberId);
    if (!validId(id)) return json(res, 400, { error: 'invalid_member' });
    try {
      const rec = await store.spin(id);
      const active = (await store.getPrizes()).filter(x => x.qty > 0 || x.id === rec.prizeId).map(x => x.name);
      return json(res, 200, { product: rec.product, activeProducts: active });
    } catch (e) {
      if (e instanceof AlreadyPlayed) return json(res, 409, { played: true, product: e.product });
      if (e instanceof OutOfStock) return json(res, 409, { error: 'out_of_stock' });
      throw e;
    }
  }

  /* หลังบ้าน */
  if (p === '/admin/login') {
    if (req.method === 'POST') {
      const pw = new URLSearchParams(await readBody(req)).get('password') || '';
      if (samePassword(pw)) return send(res, 302, '', 'text/plain', { Location: '/admin', 'Set-Cookie': `ls_admin=${makeSession()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` });
      return send(res, 401, loginPage('รหัสผ่านไม่ถูกต้อง'));
    }
    return send(res, 200, loginPage());
  }
  if (p.startsWith('/admin')) {
    if (!isAdmin(req)) return send(res, 302, '', 'text/plain', { Location: '/admin/login' });
    if (p === '/admin/logout') return send(res, 302, '', 'text/plain', { Location: '/admin/login', 'Set-Cookie': 'ls_admin=; Path=/; Max-Age=0' });
    if (p === '/admin/export.csv') {
      const plays = await store.listPlays();
      const q = v => `"${String(v).replace(/"/g, '""')}"`;
      const csv = '﻿' + ['เวลา,รหัสสมาชิก,รางวัล', ...plays.map(r => [thaiTime(r.at), r.memberId, r.product].map(q).join(','))].join('\r\n');
      const fname = `luckyspin-${new Date().toISOString().slice(0, 10)}.csv`;
      return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${fname}"` });
    }
    if (req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req, 1.5e6));
      let msg = '', isErr = false;
      if (p === '/admin/prize/save' || p === '/admin/prize/add') {
        const r = await validatePrizeForm(f);
        if (r.error) { msg = r.error; isErr = true; }
        else if (p === '/admin/prize/add') {
          if (!r.img) { msg = 'กรุณาเลือกรูปสินค้า'; isErr = true; }
          else { await store.addPrize(r); msg = `เพิ่ม "${r.name}" แล้ว`; }
        } else {
          try { await store.savePrize(r.id, r); msg = `บันทึก "${r.name}" แล้ว (คงเหลือ ${r.qty})`; }
          catch (e) { if (!(e instanceof NotFound)) throw e; msg = 'ไม่พบรางวัลนี้ (อาจถูกลบไปแล้ว)'; isErr = true; }
        }
      } else if (p === '/admin/prize/delete') {
        await store.deletePrize(String(f.get('id') || '')); msg = 'ลบรางวัลแล้ว';
      } else if (p === '/admin/delete-play') {
        await store.deletePlay(cleanId(f.get('memberId'))); msg = 'ลบรายการแล้ว';
      } else if (p === '/admin/reset') {
        if (f.get('confirm') === 'RESET') { await store.resetAll(); msg = 'รีเซ็ตเรียบร้อย'; } else msg = 'ไม่ได้รีเซ็ต — ต้องพิมพ์ RESET ให้ถูกต้อง';
      }
      return send(res, 200, await dashboard(msg, isErr));
    }
    if (p === '/admin' || p === '/admin/') return send(res, 200, await dashboard());
  }

  /* ไฟล์ภาพ */
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(__dirname, 'public', safe);
  if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(file).pipe(res);
  }
  return send(res, 404, 'Not found', 'text/plain');
}

function safeHandle(req, res) {
  return handle(req, res).catch(err => { console.error(err); if (!res.headersSent) json(res, 500, { error: 'server_error' }); });
}
module.exports = { safeHandle };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  http.createServer(safeHandle)
    .listen(PORT, () => console.log(`Lucky Spin พร้อมที่ http://localhost:${PORT}  (store: ${store.kind})`));
}

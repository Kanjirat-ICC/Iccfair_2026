'use strict';
/* สร้างโฟลเดอร์ .amplify-hosting/ ตามรูปแบบที่ AWS Amplify (WEB_COMPUTE) ต้องการ */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, '.amplify-hosting');
const compute = path.join(out, 'compute', 'default');
const stat = path.join(out, 'static');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(compute, { recursive: true });
fs.mkdirSync(stat, { recursive: true });

const copy = (src, dst) => fs.cpSync(path.join(root, src), dst, { recursive: true });
['server.js', 'store.js', 'event.config.json', 'package.json', 'views'].forEach(f => copy(f, path.join(compute, f)));
/* เซิร์ฟเวอร์ต้องเห็นรายชื่อไฟล์ภาพ (wheel/logo) เพื่อเลือกภาพที่ถูกต้อง */
copy('public', path.join(compute, 'public'));
if (fs.existsSync(path.join(root, 'node_modules'))) copy('node_modules', path.join(compute, 'node_modules'));
else console.warn('⚠️  ไม่พบ node_modules — รัน npm install --omit=dev ก่อน (จำเป็นสำหรับ DynamoDB)');
if (fs.existsSync(path.join(root, '.env'))) copy('.env', path.join(compute, '.env'));
else console.warn('⚠️  ไม่พบไฟล์ .env — หลังบ้านจะยังไม่มีรหัสผ่าน');
copy('public', stat);

/* ตรวจว่าไฟล์ภาพรางวัลครบตาม config */
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'event.config.json'), 'utf8'));
const missing = cfg.prizes.filter(p => !fs.existsSync(path.join(root, 'public', 'prizes', p.file)));
if (missing.length) { console.error('❌ ไม่พบไฟล์ภาพรางวัล:', missing.map(p => p.file).join(', ')); process.exit(1); }

fs.writeFileSync(path.join(out, 'deploy-manifest.json'), JSON.stringify({
  version: 1,
  framework: { name: 'nodejs-http', version: '1.0.0' },
  routes: [
    { path: '/prizes/*', target: { kind: 'Static', cacheControl: 'public, max-age=86400' } },
    { path: '/assets/*', target: { kind: 'Static', cacheControl: 'public, max-age=86400' } },
    { path: '/*', target: { kind: 'Compute', src: 'default' } },
  ],
  computeResources: [{ name: 'default', runtime: 'nodejs20.x', entrypoint: 'server.js' }],
}, null, 2));
console.log('✅ สร้าง .amplify-hosting/ เรียบร้อย');

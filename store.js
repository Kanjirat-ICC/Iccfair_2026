'use strict';
/*
 * ที่เก็บข้อมูล 2 แบบ
 *  - memory   : ใช้ทดสอบในเครื่อง (ข้อมูลหายเมื่อปิดโปรแกรม) — ใช้เมื่อไม่ได้ตั้ง TABLE_NAME
 *  - dynamodb : ใช้จริงบน AWS — ตั้ง TABLE_NAME (+ AWS_REGION)
 *
 * โครงสร้างตาราง DynamoDB (partition key "pk" ชนิด String)
 *   pk = "PRIZE#<id>"  → { id, name, qty (คงเหลือ), init (ค่าตั้งต้นสำหรับรีเซ็ต), ord (ลำดับ), file?, imgVer? }
 *   pk = "IMG#<id>"    → { data: "data:image/...;base64,..." }   (รูปที่อัปโหลดจากหลังบ้าน)
 *   pk = "PLAY#<รหัส>" → { memberId, product, prizeId, at }
 *   pk = "META#seeded" → บอกว่าเคยใส่รางวัลตั้งต้นจาก event.config.json แล้ว
 *   (pk = "STOCK#<ชื่อ>" เป็นรูปแบบเก่า — อ่านครั้งเดียวตอนย้ายข้อมูล)
 */

class OutOfStock extends Error {}
class AlreadyPlayed extends Error { constructor(product) { super('played'); this.product = product; } }
class NotFound extends Error {}

/* สุ่มแบบถ่วงน้ำหนักตามจำนวนคงเหลือ (ของเหลือเยอะ ออกบ่อยกว่า) */
function pickWeighted(prizes) {
  const pool = prizes.filter(p => p.qty > 0);
  const total = pool.reduce((s, p) => s + p.qty, 0);
  if (!total) return null;
  let r = Math.random() * total;
  for (const p of pool) { if ((r -= p.qty) < 0) return p; }
  return pool[pool.length - 1];
}

const IMG_SLOTS = ['', ':logo', ':full'];
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const seedList = cfgPrizes => cfgPrizes.map((p, i) => ({
  id: p.file.replace(/\.[a-z]+$/i, ''), name: p.name, qty: p.stock, init: p.stock, ord: i, file: p.file,
}));
const byOrd = (a, b) => a.ord - b.ord;

/* ════════════════ MEMORY ════════════════ */
function memoryStore(cfgPrizes) {
  let prizes = new Map(seedList(cfgPrizes).map(p => [p.id, p]));
  const images = new Map();
  const plays = new Map();
  const clone = o => JSON.parse(JSON.stringify(o));
  /* ชุดรูปของรางวัลที่อัปโหลด: รูปสินค้า (บนวงล้อ), โลโก้ (ขอบนอกวงล้อ), รูปเต็ม (ป๊อปอัป) */
  const setImgs = (p, { img, logo, full }) => {
    images.set(p.id, img);
    logo ? images.set(p.id + ':logo', logo) : images.delete(p.id + ':logo');
    full ? images.set(p.id + ':full', full) : images.delete(p.id + ':full');
    p.imgVer = Date.now(); p.hasLogo = !!logo; p.hasFull = !!full;
  };
  return {
    kind: 'memory',
    async getPrizes() { return [...prizes.values()].map(clone).sort(byOrd); },
    async getImage(id) { return images.get(id) || null; },
    async getPlay(id) { return plays.get(id) || null; },
    async spin(memberId) {
      if (plays.has(memberId)) throw new AlreadyPlayed(plays.get(memberId).product);
      const p = pickWeighted([...prizes.values()]);
      if (!p) throw new OutOfStock();
      p.qty -= 1;
      const rec = { memberId, product: p.name, prizeId: p.id, at: new Date().toISOString() };
      plays.set(memberId, rec);
      return rec;
    },
    async savePrize(id, { name, qty, img, logo, full }) {
      const p = prizes.get(id); if (!p) throw new NotFound();
      p.name = name; p.qty = qty; p.init = qty;
      if (img) setImgs(p, { img, logo, full });
    },
    async addPrize({ name, qty, img, logo, full }) {
      const id = newId();
      const ord = Math.max(-1, ...[...prizes.values()].map(p => p.ord)) + 1;
      const p = { id, name, qty, init: qty, ord };
      if (img) setImgs(p, { img, logo, full });
      prizes.set(id, p);
      return id;
    },
    async deletePrize(id) { prizes.delete(id); for (const s of IMG_SLOTS) images.delete(id + s); },
    async listPlays() { return [...plays.values()].sort((a, b) => a.at.localeCompare(b.at)); },
    async deletePlay(id) { plays.delete(id); },
    async resetAll() { plays.clear(); prizes.forEach(p => { p.qty = p.init; }); },
  };
}

/* ════════════════ DYNAMODB ════════════════ */
function dynamoStore(cfgPrizes, table, region) {
  const ddb = require('@aws-sdk/client-dynamodb');
  const client = new ddb.DynamoDBClient({ region });
  const S = v => ({ S: String(v) });
  const N = v => ({ N: String(v) });
  const send = cmd => client.send(cmd);

  async function scanAll(prefix) {
    const items = []; let ExclusiveStartKey;
    do {
      const r = await send(new ddb.ScanCommand({
        TableName: table, ExclusiveStartKey, ConsistentRead: true,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': S(prefix) },
      }));
      items.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  const toPrize = i => ({
    id: i.id.S, name: i.name.S, qty: Number(i.qty.N), init: Number((i.init || i.qty).N), ord: Number(i.ord.N),
    file: i.file ? i.file.S : undefined, imgVer: i.imgVer ? Number(i.imgVer.N) : undefined,
    hasLogo: !!(i.hasLogo && i.hasLogo.BOOL), hasFull: !!(i.hasFull && i.hasFull.BOOL),
  });
  /* เก็บชุดรูป (สินค้า/โลโก้/รูปเต็ม) แยกเป็นรายการ IMG#<id>, IMG#<id>:logo, IMG#<id>:full */
  async function putImgs(id, { img, logo, full }) {
    for (const [slot, data] of [['', img], [':logo', logo], [':full', full]]) {
      const Key = { pk: S('IMG#' + id + slot) };
      if (data) await send(new ddb.PutItemCommand({ TableName: table, Item: { ...Key, data: S(data) } }));
      else if (slot) await send(new ddb.DeleteItemCommand({ TableName: table, Key }));
    }
  }

  /* ใส่รางวัลตั้งต้นครั้งแรกครั้งเดียว (ย้ายจำนวนคงเหลือจากรูปแบบเก่า STOCK#<ชื่อ> ถ้ามี) */
  async function seed() {
    const meta = await send(new ddb.GetItemCommand({ TableName: table, Key: { pk: S('META#seeded') }, ConsistentRead: true }));
    if (meta.Item) return;
    const old = {};
    (await scanAll('STOCK#')).forEach(i => { old[i.pk.S.slice(6)] = Number(i.qty.N); });
    for (const p of seedList(cfgPrizes)) {
      const qty = p.name in old ? old[p.name] : p.qty;
      await send(new ddb.PutItemCommand({
        TableName: table, ConditionExpression: 'attribute_not_exists(pk)',
        Item: { pk: S('PRIZE#' + p.id), id: S(p.id), name: S(p.name), qty: N(qty), init: N(p.init), ord: N(p.ord), file: S(p.file) },
      })).catch(e => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
    }
    await send(new ddb.PutItemCommand({ TableName: table, Item: { pk: S('META#seeded'), at: S(new Date().toISOString()) } }));
  }
  /* ทำแบบ lazy: ถ้าฐานข้อมูลยังเชื่อมไม่ได้ เซิร์ฟเวอร์ไม่ล่ม และจะลองใหม่ครั้งถัดไป */
  let ready = null;
  const ensureReady = () => (ready ||= seed().catch(e => { ready = null; throw e; }));

  const store = {
    kind: 'dynamodb',
    async getPrizes() {
      await ensureReady();
      return (await scanAll('PRIZE#')).map(toPrize).sort(byOrd);
    },
    async getImage(id) {
      const r = await send(new ddb.GetItemCommand({ TableName: table, Key: { pk: S('IMG#' + id) } }));
      return r.Item ? r.Item.data.S : null;
    },
    async getPlay(id) {
      const r = await send(new ddb.GetItemCommand({ TableName: table, Key: { pk: S('PLAY#' + id) }, ConsistentRead: true }));
      if (!r.Item) return null;
      return { memberId: r.Item.memberId.S, product: r.Item.product.S, at: r.Item.at.S };
    },
    async spin(memberId) {
      const existing = await store.getPlay(memberId);
      if (existing) throw new AlreadyPlayed(existing.product);
      /* ลองใหม่สูงสุด 5 ครั้ง กรณีมีคนหมุนพร้อมกันแล้วของชิ้นสุดท้ายถูกตัดไปก่อน */
      for (let attempt = 0; attempt < 5; attempt++) {
        const p = pickWeighted(await store.getPrizes());
        if (!p) throw new OutOfStock();
        const rec = { memberId, product: p.name, prizeId: p.id, at: new Date().toISOString() };
        try {
          await send(new ddb.TransactWriteItemsCommand({ TransactItems: [
            { Put: {
                TableName: table, ConditionExpression: 'attribute_not_exists(pk)',
                Item: { pk: S('PLAY#' + memberId), memberId: S(memberId), product: S(p.name), prizeId: S(p.id), at: S(rec.at) },
            } },
            { Update: {
                TableName: table, Key: { pk: S('PRIZE#' + p.id) },
                UpdateExpression: 'SET qty = qty - :one',
                ConditionExpression: 'qty >= :one',
                ExpressionAttributeValues: { ':one': N(1) },
            } },
          ] }));
          return rec;
        } catch (e) {
          if (e.name !== 'TransactionCanceledException') throw e;
          const reasons = (e.CancellationReasons || []).map(r => r.Code);
          if (reasons[0] === 'ConditionalCheckFailed') {
            const prev = await store.getPlay(memberId);
            throw new AlreadyPlayed(prev ? prev.product : '');
          }
          /* ชิ้นนั้นหมดพอดี → สุ่มใหม่ */
        }
      }
      throw new OutOfStock();
    },
    async savePrize(id, { name, qty, img, logo, full }) {
      const names = { '#n': 'name' };
      const vals = { ':n': S(name), ':q': N(qty) };
      let expr = 'SET #n = :n, qty = :q, init = :q';
      if (img) {
        await putImgs(id, { img, logo, full });
        expr += ', imgVer = :v, hasLogo = :hl, hasFull = :hf';
        vals[':v'] = N(Date.now()); vals[':hl'] = { BOOL: !!logo }; vals[':hf'] = { BOOL: !!full };
      }
      try {
        await send(new ddb.UpdateItemCommand({
          TableName: table, Key: { pk: S('PRIZE#' + id) }, ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
        }));
      } catch (e) { if (e.name === 'ConditionalCheckFailedException') throw new NotFound(); throw e; }
    },
    async addPrize({ name, qty, img, logo, full }) {
      const id = newId();
      const ord = Math.max(-1, ...(await store.getPrizes()).map(p => p.ord)) + 1;
      const item = { pk: S('PRIZE#' + id), id: S(id), name: S(name), qty: N(qty), init: N(qty), ord: N(ord) };
      if (img) {
        await putImgs(id, { img, logo, full });
        item.imgVer = N(Date.now()); item.hasLogo = { BOOL: !!logo }; item.hasFull = { BOOL: !!full };
      }
      await send(new ddb.PutItemCommand({ TableName: table, Item: item }));
      return id;
    },
    async deletePrize(id) {
      await send(new ddb.DeleteItemCommand({ TableName: table, Key: { pk: S('PRIZE#' + id) } }));
      for (const s of IMG_SLOTS) await send(new ddb.DeleteItemCommand({ TableName: table, Key: { pk: S('IMG#' + id + s) } }));
    },
    async listPlays() {
      return (await scanAll('PLAY#'))
        .map(i => ({ memberId: i.memberId.S, product: i.product.S, at: i.at.S }))
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    async deletePlay(id) {
      await send(new ddb.DeleteItemCommand({ TableName: table, Key: { pk: S('PLAY#' + id) } }));
    },
    async resetAll() {
      for (const i of await scanAll('PLAY#')) {
        await send(new ddb.DeleteItemCommand({ TableName: table, Key: { pk: i.pk } }));
      }
      for (const p of await store.getPrizes()) {
        await send(new ddb.UpdateItemCommand({
          TableName: table, Key: { pk: S('PRIZE#' + p.id) },
          UpdateExpression: 'SET qty = :q', ExpressionAttributeValues: { ':q': N(p.init) },
        }));
      }
    },
  };
  return store;
}

function createStore(cfgPrizes) {
  const table = process.env.TABLE_NAME;
  if (table) return dynamoStore(cfgPrizes, table, process.env.AWS_REGION || 'ap-southeast-2');
  return memoryStore(cfgPrizes);
}

module.exports = { createStore, OutOfStock, AlreadyPlayed, NotFound, pickWeighted };

'use strict';
/*
 * ที่เก็บข้อมูล 2 แบบ
 *  - memory   : ใช้ทดสอบในเครื่อง (ข้อมูลหายเมื่อปิดโปรแกรม) — ใช้เมื่อไม่ได้ตั้ง TABLE_NAME
 *  - dynamodb : ใช้จริงบน AWS — ตั้ง TABLE_NAME (+ AWS_REGION) แล้วระบบจะใช้ DynamoDB อัตโนมัติ
 *
 * โครงสร้างตาราง DynamoDB (partition key ชื่อ "pk" ชนิด String)
 *   pk = "STOCK#<ชื่อรางวัล>"  → { qty: จำนวนคงเหลือ }
 *   pk = "PLAY#<รหัสสมาชิก>"   → { memberId, product, at }
 */

class OutOfStock extends Error {}
class AlreadyPlayed extends Error { constructor(product) { super('played'); this.product = product; } }

/* ── เลือกรางวัล: สุ่มแบบถ่วงน้ำหนักตามจำนวนคงเหลือ (ของเหลือเยอะ ออกบ่อยกว่า) ── */
function pickWeighted(stock) {
  const entries = Object.entries(stock).filter(([, q]) => q > 0);
  const total = entries.reduce((s, [, q]) => s + q, 0);
  if (!total) return null;
  let r = Math.random() * total;
  for (const [name, q] of entries) { if ((r -= q) < 0) return name; }
  return entries[entries.length - 1][0];
}

/* ════════════════ MEMORY ════════════════ */
function memoryStore(prizes) {
  const stock = {};
  const plays = new Map();
  prizes.forEach(p => { stock[p.name] = p.stock; });
  return {
    kind: 'memory',
    async getStock() { return { ...stock }; },
    async getPlay(id) { return plays.get(id) || null; },
    async spin(id, candidates) {
      if (plays.has(id)) throw new AlreadyPlayed(plays.get(id).product);
      const pool = {};
      candidates.forEach(n => { pool[n] = stock[n] || 0; });
      const name = pickWeighted(pool);
      if (!name) throw new OutOfStock();
      stock[name] -= 1;
      const rec = { memberId: id, product: name, at: new Date().toISOString() };
      plays.set(id, rec);
      return rec;
    },
    async setStock(name, qty) { stock[name] = qty; },
    async listPlays() { return [...plays.values()].sort((a, b) => a.at.localeCompare(b.at)); },
    async deletePlay(id) { plays.delete(id); },
    async resetAll() { plays.clear(); prizes.forEach(p => { stock[p.name] = p.stock; }); },
  };
}

/* ════════════════ DYNAMODB ════════════════ */
function dynamoStore(prizes, table, region) {
  const ddb = require('@aws-sdk/client-dynamodb');
  const client = new ddb.DynamoDBClient({ region });
  const S = v => ({ S: String(v) });
  const N = v => ({ N: String(v) });

  async function scanAll(prefix) {
    const items = []; let ExclusiveStartKey;
    do {
      const r = await client.send(new ddb.ScanCommand({
        TableName: table, ExclusiveStartKey,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': S(prefix) },
      }));
      items.push(...(r.Items || []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async function seedMissingStock() {
    const have = new Set((await scanAll('STOCK#')).map(i => i.pk.S));
    for (const p of prizes) {
      if (have.has('STOCK#' + p.name)) continue;
      await client.send(new ddb.PutItemCommand({
        TableName: table,
        Item: { pk: S('STOCK#' + p.name), qty: N(p.stock) },
        ConditionExpression: 'attribute_not_exists(pk)',
      })).catch(e => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
    }
  }
  /* เตรียมสต็อกเริ่มต้นแบบ lazy: ถ้าเชื่อมฐานข้อมูลไม่ได้ (เช่น ยังไม่ได้ตั้งสิทธิ์) จะไม่ทำให้เซิร์ฟเวอร์ล่ม และจะลองใหม่ครั้งถัดไป */
  let ready = null;
  const ensureReady = () => (ready ||= seedMissingStock().catch(e => { ready = null; throw e; }));

  const store = {
    kind: 'dynamodb',
    async getStock() {
      await ensureReady();
      const out = {};
      prizes.forEach(p => { out[p.name] = 0; });
      (await scanAll('STOCK#')).forEach(i => { out[i.pk.S.slice(6)] = Number(i.qty.N); });
      return out;
    },
    async getPlay(id) {
      const r = await client.send(new ddb.GetItemCommand({
        TableName: table, Key: { pk: S('PLAY#' + id) }, ConsistentRead: true,
      }));
      if (!r.Item) return null;
      return { memberId: r.Item.memberId.S, product: r.Item.product.S, at: r.Item.at.S };
    },
    async spin(id, candidates) {
      const existing = await store.getPlay(id);
      if (existing) throw new AlreadyPlayed(existing.product);
      /* ลองใหม่สูงสุด 5 ครั้ง กรณีมีคนหมุนพร้อมกันแล้วของชิ้นสุดท้ายถูกตัดไปก่อน */
      for (let attempt = 0; attempt < 5; attempt++) {
        const all = await store.getStock();
        const pool = {};
        candidates.forEach(n => { pool[n] = all[n] || 0; });
        const name = pickWeighted(pool);
        if (!name) throw new OutOfStock();
        const rec = { memberId: id, product: name, at: new Date().toISOString() };
        try {
          await client.send(new ddb.TransactWriteItemsCommand({ TransactItems: [
            { Put: {
                TableName: table,
                Item: { pk: S('PLAY#' + id), memberId: S(id), product: S(name), at: S(rec.at) },
                ConditionExpression: 'attribute_not_exists(pk)',
            } },
            { Update: {
                TableName: table, Key: { pk: S('STOCK#' + name) },
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
            const p = await store.getPlay(id);
            throw new AlreadyPlayed(p ? p.product : '');
          }
          /* stock ชิ้นนั้นหมดพอดี → สุ่มใหม่ */
        }
      }
      throw new OutOfStock();
    },
    async setStock(name, qty) {
      await client.send(new ddb.PutItemCommand({ TableName: table, Item: { pk: S('STOCK#' + name), qty: N(qty) } }));
    },
    async listPlays() {
      return (await scanAll('PLAY#'))
        .map(i => ({ memberId: i.memberId.S, product: i.product.S, at: i.at.S }))
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    async deletePlay(id) {
      await client.send(new ddb.DeleteItemCommand({ TableName: table, Key: { pk: S('PLAY#' + id) } }));
    },
    async resetAll() {
      for (const i of await scanAll('PLAY#')) {
        await client.send(new ddb.DeleteItemCommand({ TableName: table, Key: { pk: i.pk } }));
      }
      for (const p of prizes) await store.setStock(p.name, p.stock);
    },
  };
  return store;
}

function createStore(prizes) {
  const table = process.env.TABLE_NAME;
  if (table) return dynamoStore(prizes, table, process.env.AWS_REGION || 'ap-southeast-2');
  return memoryStore(prizes);
}

module.exports = { createStore, OutOfStock, AlreadyPlayed, pickWeighted };

'use strict';
/* ตัวเชื่อมสำหรับรันบน AWS Lambda (Function URL) — ใช้กับ region ที่ไม่มี Amplify เช่น Thailand (ap-southeast-7) */
const { Readable, Writable } = require('stream');
const { safeHandle } = require('./server');

exports.handler = async (event) => {
  const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (event.cookies && event.cookies.length) headers.cookie = event.cookies.join('; ');
  const qs = event.rawQueryString ? '?' + event.rawQueryString : '';

  const req = Readable.from(body.length ? [body] : []);
  req.method = event.requestContext?.http?.method || 'GET';
  req.url = (event.rawPath || '/') + qs;
  req.headers = headers;

  return new Promise((resolve) => {
    const chunks = []; let status = 200; let outHeaders = {};
    const res = new Writable({
      write(chunk, enc, cb) { chunks.push(Buffer.from(chunk, enc)); cb(); },
    });
    res.headersSent = false;
    res.writeHead = (code, h = {}) => { status = code; outHeaders = { ...outHeaders, ...h }; res.headersSent = true; return res; };
    res.on('finish', () => {
      const buf = Buffer.concat(chunks);
      const cookies = [];
      const h = {};
      for (const [k, v] of Object.entries(outHeaders)) {
        if (k.toLowerCase() === 'set-cookie') cookies.push(...[].concat(v)); else h[k] = String(v);
      }
      const type = (h['Content-Type'] || '').toLowerCase();
      const text = /^(text\/|application\/json|image\/svg)/.test(type);
      resolve({ statusCode: status, headers: h, cookies,
        body: text ? buf.toString('utf8') : buf.toString('base64'), isBase64Encoded: !text });
    });
    safeHandle(req, res);
  });
};

/* 团契智学 NAS/Docker 版：Node.js 适配层
 * 把 Cloudflare Worker 的 fetch handler 跑在 Node http server 上，
 * D1 换成 better-sqlite3 本地文件。worker.js 本体零修改。 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { D1Shim } from './d1-shim.mjs';
import { ensureSchema } from './init-db.mjs';

const PORT = parseInt(process.env.PORT || '8080', 10);
const DB_PATH = process.env.DB_PATH || '/data/fellowship.db';
const WORKER_PATH = process.env.WORKER_PATH || '/app/worker.js';

// 确保数据目录存在
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new D1Shim(DB_PATH);
console.log('[tuanqi] SQLite:', DB_PATH);
await ensureSchema(db);
console.log('[tuanqi] schema 就绪');

// 动态导入 worker（ESM）
const worker = (await import(WORKER_PATH)).default;
if (!worker || typeof worker.fetch !== 'function') {
  console.error('[tuanqi] worker.js 没有 export default { fetch }');
  process.exit(1);
}
console.log('[tuanqi] worker 已加载:', WORKER_PATH);

const env = { DB: db };

function nodeReqToWeb(req, bodyBuf) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  // Node 的 Headers 含 host 等，fetch handler 只读需要的，无妨
  const init = { method: req.method, headers };
  if (bodyBuf && bodyBuf.length && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = bodyBuf;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      const webReq = nodeReqToWeb(req, body);
      const webRes = await worker.fetch(webReq, env);

      res.statusCode = webRes.status;
      webRes.headers.forEach((v, k) => {
        // 跳过 Node 会自己处理的头
        if (k.toLowerCase() === 'content-encoding' && v === 'gzip') return;
        res.setHeader(k, v);
      });
      const buf = Buffer.from(await webRes.arrayBuffer());
      res.setHeader('content-length', buf.length);
      res.end(buf);
    } catch (e) {
      console.error('[tuanqi] 请求处理失败:', e);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
  req.on('error', () => res.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[tuanqi] listening on :${PORT}`);
});

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('[tuanqi] shutting down...');
    server.close(() => {
      try { db.close(); } catch (e) {}
      process.exit(0);
    });
  });
}

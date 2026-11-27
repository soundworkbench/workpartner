import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { brotliDecompressSync } from 'node:zlib';
import { gatewayFixture, memoryTransport } from './gateway-fixture.mjs';

const js = Buffer.from('export const data = ' + JSON.stringify(Array.from({ length: 18000 }, (_, i) => `asset-item-${i}`)) + ';\n');
const body = Buffer.alloc(500 * 1024, ' '); js.copy(body);
const upstream = http.createServer((req, res) => {
  if (req.url === '/login') { res.writeHead(200, { 'set-cookie': ['session=synthetic'] }); return res.end('{}'); }
  const html = req.url === '/index.html';
  const data = html ? Buffer.from('<!doctype html><title>Gateway fixture</title>' + ' '.repeat(2048)) : body;
  res.writeHead(200, { 'content-type': html ? 'text/html' : 'application/javascript', 'content-length': data.length });
  res.end(data);
});
const args = process.argv.slice(2), noListen = args.includes('--no-listen');
const baselineRoot = args.find(arg => arg !== '--no-listen');
const servers = new Map();
const restoreTransport = noListen ? memoryTransport(servers) : () => {};
async function start(server, port) {
  if (noListen) { servers.set(port, server); server.address = () => ({ port }); }
  else { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
}
let fixture;
try {
  await start(upstream, 1);
  fixture = await gatewayFixture({ address: { host: '127.0.0.1', port: upstream.address().port }, delay: 300,
    ...(baselineRoot ? { root: baselineRoot } : {}) });
  await start(fixture.server, 2);
  const request = (route, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request({ host: '127.0.0.1', port: fixture.server.address().port, path: route, method,
      headers: { host: 'perf.test', cookie: fixture.cookie, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Math.round(performance.now() - start) }));
    });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
  const rows = [];
  for (const route of ['/_wp/feishu-bot/bots', '/_wp/aionui/feishu/status']) {
    const before = fixture.calls.length, results = [];
    for (let i = 0; i < 3; i++) { const result = await request(route); assert.equal(result.status, 200); results.push(result.ms); }
    rows.push([`${route} 连续三次`, 'exec 3→1，后两次 <30ms', `exec=${fixture.calls.length - before}，${results.join('/')}ms`]);
  }
  await request('/_wp/feishu-bot/reconnect', { origin: 'https://perf.test', 'content-type': 'application/json' }, 'POST');
  const before = fixture.calls.length, afterWrite = await request('/_wp/feishu-bot/bots');
  rows.push(['写后再次 bots', 'exec=1', `exec=${fixture.calls.length - before}，${afterWrite.ms}ms`]);
  const fields = result => `status=${result.status}; cache-control=${result.headers['cache-control'] || '-'}; content-encoding=${result.headers['content-encoding'] || '-'}; etag=${result.headers.etag || '-'}; vary=${result.headers.vary || '-'}; bytes=${result.body.length}`;
  for (const route of ['/assets/index-AbCd1234.imm.js', '/assets/index-AbCd1234.js', '/index.html', '/_wp/preview/client.js']) {
    const first = await request(route, { 'accept-encoding': 'br, gzip' });
    assert.equal(first.status, 200);
    const second = await request(route, { 'accept-encoding': 'br, gzip', 'if-none-match': first.headers.etag || '' });
    rows.push([route, '200（标记文件 immutable，其他 no-cache）', fields(first)]);
    rows.push([`${route} 条件请求`, '304，无正文', fields(second)]);
    if (route.includes('.imm.') && first.headers['content-encoding'] === 'br') {
      assert.deepEqual(brotliDecompressSync(first.body), body);
      rows.push(['500KB JS br 传输字节', '小于 512000', `${first.body.length}（原文 ${body.length}）`]);
    }
  }
  if (noListen) console.log('无端口传输替身：真实网关处理链；耗时不代表 HTTP 网络性能。');
  console.log('指标\t现状期望值\t本次结果');
  for (const row of rows) console.log(row.join('\t'));
} finally {
  restoreTransport(); fixture?.close(); upstream.closeAllConnections(); upstream.close();
}

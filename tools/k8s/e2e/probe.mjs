import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns/promises';
import fs, { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export function tcp({ host, port, timeout = 1500 }) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (open, reason) => { socket.destroy(); resolve({ open, reason }); };
    socket.setTimeout(timeout, () => done(false, 'timeout'));
    socket.once('connect', () => done(true, 'connected'));
    socket.once('error', error => done(false, error.code));
  });
}
export function request({ host, port, path = '/', headers = {}, timeout = 3000 }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, headers }, res => {
      res.resume(); res.once('end', () => resolve({ status: res.statusCode }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('HTTP probe timed out')));
    req.on('error', reject);
  });
}
export async function probe(spec) {
  if (spec.kind === 'dns') return (await dns.lookup(spec.host, { all: true })).map(item => item.address);
  if (spec.kind === 'lookup') {
    const start = performance.now();
    try { return { addresses: await dns.lookup(spec.host, { all: true }), ms: performance.now() - start }; }
    catch (error) { return { error: error.code, ms: performance.now() - start }; }
  }
  if (spec.kind === 'resolv') return fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n')
    .filter(line => /^\s*(search|options)\s/.test(line));
  if (spec.kind === 'http') return request(spec);
  if (spec.kind === 'route') {
    const route = readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === '00000000');
    if (!route) throw new Error('No IPv4 default route');
    return route[2].match(/../g).reverse().map(value => parseInt(value, 16)).join('.');
  }
  return tcp(spec);
}
// The same source is passed to node --input-type=module in fixture Pods.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await probe(JSON.parse(readFileSync(0, 'utf8'))))); }
  catch (error) { console.error(error.code || error.name); process.exitCode = 1; }
}

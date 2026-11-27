import { desktopTools, object, failure } from './desktop-tools.mjs';

/** Stateless Streamable HTTP, mounted exclusively on the internal listener. */
export function createDesktopMcp({ authenticate, desktopRelay }) {
  return async function handle(req, res, url) {
    if (url.pathname !== '/desktop-mcp') return false;
    const reply = (status, body) => {
      if (res.destroyed) return true;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'POST' } : {}) });
      res.end(body === undefined ? undefined : JSON.stringify(body)); return true;
    };
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    let user;
    try { user = authenticate(req); } catch { /* Invalid identity state fails closed. */ }
    if (!user) return reply(401, { error: 'unauthorized' });
    let message;
    try {
      const body = await new Promise((resolve, reject) => {
        let size = 0, over = false;
        const chunks = [];
        req.on('data', chunk => {
          size += chunk.length;
          if (size > 262144) {
            if (!over) { over = true; chunks.length = 0; reject(new Error('limit')); }
          } else if (!over) chunks.push(chunk);
        });
        req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
        req.on('error', () => reject(new Error('body')));
        req.on('aborted', () => reject(new Error('body')));
      });
      message = JSON.parse(body);
    } catch (error) {
      if (error.message === 'limit') return reply(413, { error: 'PAYLOAD_TOO_LARGE' });
      return reply(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const hasId = object(message) && Object.hasOwn(message, 'id');
    const validId = !hasId || typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id));
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !validId
      || (message.params !== undefined && !object(message.params))) return reply(200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    if (!hasId) return reply(202);
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'workpartner-desktop', version: '1.0.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: desktopTools }; break;
      case 'tools/call': {
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        try { result = await desktopRelay.call(user, message.params, controller.signal); }
        catch { result = failure('INTERNAL_ERROR'); }
        finally { res.off('close', abort); }
        break;
      }
      default: return reply(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
    return reply(200, { jsonrpc: '2.0', id: message.id, result });
  };
}

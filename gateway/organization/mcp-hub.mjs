// Bounded Streamable HTTP discovery. Never expose response bodies or credentials in errors.
export function hubConfig(value) {
  if (!value?.url) return null;
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^[A-Z_][A-Z0-9_]*$/.test(value.keyEnvironment)
    || !/^[a-z][a-z0-9_-]*$/.test(value.name || 'workpartner-hub')
    || (value.hidden !== undefined && (!Array.isArray(value.hidden)
      || value.hidden.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+$/.test(name))))) throw new Error('Invalid MCP hub configuration');
  const localized = item => item && typeof item.zh === 'string' && item.zh.trim() && typeof item.en === 'string' && item.en.trim();
  const platform = item => item && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) && localized(item.name);
  if ((value.defaultCategory !== undefined && (typeof value.defaultCategory !== 'string' || !value.defaultCategory.trim()))
    || (value.categories !== undefined && (!Array.isArray(value.categories) || !value.categories.every(localized)
      || new Set(value.categories.map(row => row.en)).size !== value.categories.length))
    || (value.platform !== undefined && !platform(value.platform))
    || (value.tools !== undefined && (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)
      || Object.entries(value.tools).some(([name, tool]) => !/^[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+$/.test(name)
        || !tool || typeof tool !== 'object' || Array.isArray(tool)
        || (tool.category !== undefined && (typeof tool.category !== 'string' || !tool.category.trim()))
        || (tool.platform !== undefined && !platform(tool.platform))
        || (tool.example !== undefined && !localized(tool.example)))))) throw new Error('Invalid MCP market presentation');
  return { ...value, url: url.href, name: value.name || 'workpartner-hub' };
}

export async function listHubTools(config, key, { fetch: request = fetch, timeoutMs = 3000 } = {}) {
  if (!config || !key) return [];
  const signal = AbortSignal.timeout(timeoutMs);
  let session, protocol = '2025-03-26', id = 0;
  async function rpc(method, params, notification = false) {
    const messageId = notification ? undefined : ++id;
    const response = await request(config.url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': protocol, ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: messageId }), method, ...(params ? { params } : {}) }) });
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new Error('MCP hub denied'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('MCP hub unavailable'); }
    session = response.headers.get('mcp-session-id') || session;
    if (notification) { await response.body?.cancel(); return; }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    let buffer = '', bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) { bytes += value.length; buffer += decoder.decode(value, { stream: true }); }
        if (bytes > 2 * 1024 * 1024) throw new Error('MCP hub response too large');
        if (sse) {
          buffer = buffer.replaceAll('\r\n', '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const message = JSON.parse(data);
            if (message.id === messageId) {
              if (message.error) throw new Error('MCP hub RPC failed');
              return message.result;
            }
          }
        } else if (done) {
          const message = JSON.parse(buffer);
          if (message.id !== messageId || message.error) throw new Error('MCP hub RPC failed');
          return message.result;
        }
        if (done) throw new Error('MCP hub response incomplete');
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'workpartner', version: '1' } });
  if (!initialized?.protocolVersion) throw new Error('Invalid MCP initialization');
  protocol = initialized.protocolVersion;
  await rpc('notifications/initialized', undefined, true);
  const tools = [], cursors = new Set(); let cursor;
  do {
    const result = await rpc('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(result?.tools) || result.tools.some(tool => typeof tool.name !== 'string' || !tool.name
      || (tool.description !== undefined && typeof tool.description !== 'string'))) throw new Error('Invalid MCP tools');
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || tools.length > 10000)) throw new Error('Invalid MCP pagination');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

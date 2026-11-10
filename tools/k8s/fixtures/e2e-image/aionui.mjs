import http from 'node:http';
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/auth/status') res.end(JSON.stringify({ success: true, data: { authenticated: true } }));
  else if (req.url === '/api/conversations' || req.url === '/api/chat') res.end(JSON.stringify({ success: true, data: [], message: 'fixture reply' }));
  else { res.statusCode = 404; res.end('{}'); }
}).listen(25808, '0.0.0.0');
http.createServer((req, res) => res.end('fixture preview')).listen(18080, '127.0.0.1');

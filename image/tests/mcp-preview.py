#!/usr/bin/env python3
"""Local visual fixture using real market source and styles; metadata is illustrative."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
r=Path(__file__).resolve().parents[2]
# Exercise the unchanged market host and the real Tools renderer/CSS; no application build or account needed.
source=(r/'image/rebrand/overlay/wp-overlay.js').read_text()
a=source.index('  var marketRenderers =')
b=source.index('  // ---------- 输入框下面',a)
market=source[a:b]
copy=(r/'org/default/appearance/copy.js').read_text()
bootstrap=copy+'''\nfunction locale(){return new URLSearchParams(location.search).get('lang')==='en'?'en-US':'zh-CN'}
function t(key){return COPY[locale()][key]||key} function text(node,value){if(node)node.textContent=value} function schedule(){}
'''+market+'\nmarketPage();'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  path=self.path.split('?')[0]
  if path=='/market.js': data=bootstrap.encode();mime='text/javascript'
  elif path=='/tools.js':data=(r/'image/rebrand/overlay/wp-tools.js').read_bytes();mime='text/javascript'
  elif path=='/overlay.css':data=(r/'image/rebrand/overlay/wp-overlay.css').read_bytes();mime='text/css'
  elif path=='/_wp/market/tools':
   empty='empty=1' in self.headers.get('Referer','')
   data=json.dumps({'tools':[] if empty else [
    {'name':'library__find','title':{'zh':'查找资料','en':'Find resources'},'description':{'zh':'按关键词查找已获授权的资料。','en':'Find authorized resources by keyword.'}},
    {'name':'documents__read','title':{'zh':'读取文档','en':'Read documents'},'description':{'zh':'读取指定文档的内容与来源。','en':'Read a document and its source.'}},
    {'name':'catalog__list','title':{'zh':'浏览目录','en':'Browse catalog'},'description':{'zh':'查看本人可用的工具与资料目录。','en':'Browse tools and resources available to you.'}},
    {'name':'notes__lookup','title':{'zh':'查询笔记','en':'Look up notes'},'description':{'zh':'从已连接的笔记中查找相关记录。','en':'Find relevant records in connected notes.'}}
   ]}).encode();mime='application/json'
  else:
   data='''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
:root{--wp-main:#faf9f7;--wp-ink:#242424;--wp-ink-2:#626262;--wp-ink-3:#777;--wp-line:#deddd9;--wp-hover:#eeede9;--wp-card:#fff;--text-primary:#242424;--text-secondary:#626262;--bg-1:#fff;--bg-2:#f2f1ed;--border-base:#deddd9}
html[dark]{--wp-main:#202020;--wp-ink:#eee;--wp-ink-2:#aaa;--wp-ink-3:#999;--wp-line:#444;--wp-hover:#292929;--wp-card:#363636;--text-primary:#eee;--text-secondary:#aaa;--bg-1:#292929;--bg-2:#333;--border-base:#444}body{margin:0;font-family:Arial,"Noto Sans CJK SC",sans-serif;background:var(--wp-main)}
</style><link rel="stylesheet" href="/overlay.css"><div data-wp-market-host></div><script>location.hash='#/market';if(new URLSearchParams(location.search).get('dark'))document.documentElement.setAttribute('dark','')</script><script src="/market.js"></script><script src="/tools.js"></script>'''.encode();mime='text/html'
  self.send_response(200);self.send_header('Content-Type',mime);self.end_headers();self.wfile.write(data)
ThreadingHTTPServer(('127.0.0.1',18333),Handler).serve_forever()

#!/usr/bin/env python3
"""Combined data/hub visual fixture using real market source and styles; metadata is illustrative."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
import json

root = Path(__file__).resolve().parents[2]
overlay = root / 'image/rebrand/overlay'
source = (overlay / 'wp-overlay.js').read_text()
start = source.index('  var marketRenderers =')
end = source.index('  // ---------- 输入框下面', start)
bootstrap = (root / 'org/default/appearance/copy.js').read_text() + '''
function locale(){return new URLSearchParams(location.search).get('lang')==='en'?'en-US':'zh-CN'}
function t(key){return COPY[locale()][key]||key} function text(node,value){if(node)node.textContent=value} function schedule(){}
''' + source[start:end] + '\nmarketPage();'


def label(zh, en):
    return {'zh': zh, 'en': en}


research = label('资料研究', 'Research')
business = label('商业信息', 'Business')
creation = label('内容生成', 'Creation')
library = {'id': 'library', 'name': label('资料库', 'Library')}
media = {'id': 'media', 'name': label('创作服务', 'Media service')}
measurements = {'id': 'measurements', 'name': label('测量数据', 'Measurements')}
companies = {'id': 'companies', 'name': label('企业名录', 'Company directory')}


def tool(name, zh, en, description, english, **extra):
    return {'name': name, 'title': label(zh, en), 'description': label(description, english), **extra}


hub_tools = [
    tool('library__find', '查找参考资料', 'Find references', '按关键词查找已获授权的参考资料。', 'Find authorized references by keyword.', category='Research', platform=library, included=True),
    tool('library__read', '读取资料', 'Read references', '读取指定资料的内容与来源。', 'Read a reference and its source.', category='Research', platform=library, included=True),
    tool('media__render', '生成视频', 'Generate video', '根据文字描述生成视频，支持设置时长与比例。', 'Generate a video from a description, duration and aspect ratio.', category='Creation', platform=media, included=True, example=label('制作一段介绍工具使用方法的短视频', 'Create a short video explaining how to use a tool')),
    tool('media__result', '查看生成结果', 'Check generation result', '查询创作任务的进度并获取生成结果。', 'Check a creative task and retrieve its result.', category='Creation', platform=media, included=True),
]
data_tools = {
    'measurements': [tool('measurements-search', '查找测量数据', 'Find measurements', '按关键词查询公开测量资料，获取数值与来源。', 'Search public measurements with values and sources.', recommended=True, price={'kind': 'call', 'usd': 0.01}, example=label('查找公开的声学测量数据', 'Find public acoustic measurements'))],
    'companies': [tool('company-search', '查询企业信息', 'Find companies', '查看企业的公开信息，方便了解业务与联系方式。', 'Find public business and contact information.', price={'kind': 'call', 'usd': 0.02}, example=label('查找公开的企业信息', 'Find public company information'))],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        options = parse_qs(urlsplit(self.headers.get('Referer', '')).query)
        mode = options.get('mode', [''])[0]
        status = 200
        if path == '/market.js':
            data, mime = bootstrap.encode(), 'text/javascript'
        elif path in ['/tools.js', '/data-tools.js', '/mcp-tools.js']:
            data, mime = (overlay / ('wp-' + path[1:])).read_bytes(), 'text/javascript'
        elif path == '/overlay.css':
            data, mime = (overlay / 'wp-overlay.css').read_bytes(), 'text/css'
        elif path == '/_wp/market/tools':
            groups = [{'name': research, 'platforms': [library]}, {'name': creation, 'platforms': [media]}]
            value = {'groups': groups, 'tools': [] if mode == 'empty' else hub_tools}
            if 'fail' in options:
                status, value = 503, {'groups': groups, 'error': 'temporarily_unavailable'}
            data, mime = json.dumps(value).encode(), 'application/json'
        elif path == '/_wp/data/tools':
            groups = [] if mode in ['empty', 'hub-only'] else [{'name': research, 'platforms': [measurements]}, {'name': business, 'platforms': [companies]}]
            data, mime = json.dumps({'groups': groups}).encode(), 'application/json'
        elif path == '/_wp/data/catalog':
            platform = parse_qs(urlsplit(self.path).query).get('platform', [''])[0]
            data, mime = json.dumps({'tools': data_tools.get(platform, [])}).encode(), 'application/json'
        elif path == '/_wp/data/usage':
            data, mime = json.dumps({'daily': {'limitUsd': 1, 'usedUsd': 0.12}, 'monthly': {'limitUsd': 5, 'usedUsd': 0.74}}).encode(), 'application/json'
        else:
            data, mime = '''<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
:root{--wp-main:#faf9f7;--wp-ink:#242424;--wp-ink-2:#626262;--wp-ink-3:#777;--wp-line:#deddd9;--wp-hover:#eeede9;--wp-card:#fff;--text-primary:#242424;--text-secondary:#626262;--bg-1:#fff;--bg-2:#f2f1ed;--border-base:#deddd9}
html[dark]{--wp-main:#202020;--wp-ink:#eee;--wp-ink-2:#aaa;--wp-ink-3:#999;--wp-line:#444;--wp-hover:#292929;--wp-card:#363636;--text-primary:#eee;--text-secondary:#aaa;--bg-1:#292929;--bg-2:#333;--border-base:#444}body{margin:0;font-family:Arial,"Noto Sans CJK SC",sans-serif;background:var(--wp-main)}
</style><link rel="stylesheet" href="/overlay.css"><div data-wp-market-host></div><script>location.hash='#/market';if(new URLSearchParams(location.search).get('dark'))document.documentElement.setAttribute('dark','')</script><script src="/market.js"></script><script src="/tools.js"></script><script src="/data-tools.js"></script><script src="/mcp-tools.js"></script>'''.encode(), 'text/html'
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


ThreadingHTTPServer(('127.0.0.1', 18333), Handler).serve_forever()

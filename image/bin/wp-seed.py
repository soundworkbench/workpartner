"""每次启动校正助手：只开 ChatGPT（Codex）和 Claude（Claude Code），其余官方助手、Aion CLI 全部关闭，ChatGPT 排第一。
本人的模型钥匙没有 Claude 权限（模型服务的模型列表里没有 claude/*）时关掉 Claude，开通后下次启动自动出现。
第一次运行（没有 /data/.wp-seed-v2）还把界面设为中文、默认选中 ChatGPT；之后不再改本人的选择。
容器内运行：python3 -I wp-seed.py http://127.0.0.1:25808 。后端是本地模式，接口不需要登录。
显示名 ChatGPT、Claude 和图标由网页的 wp-overlay.js 换，AionUi 里登记的名字仍是 Codex CLI、Claude Code。
本人钥匙能用的模型清单每次启动写进 AionUi 的客户端设置 wp.models，网页输入框下面的模型选择只列这些；
引擎默认推理强度写进 wp.effort，对话没写推理强度时按钮按它显示。"""
import json, os, sys, time, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:25808'
ORDER = ('codex', 'claude')  # 显示顺序；第一个是默认
FIRST_RUN = '/data/.wp-seed-v2'


def call(method, path, body=None, base=BASE, headers=None):
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=15) as r:
        text = r.read().decode() or 'null'
    data = json.loads(text)
    return data.get('data', data) if isinstance(data, dict) and 'success' in data else data


def bare():
    """返回 {后端: 助手}，只含已检测到的 Codex、Claude Code 对应的“裸”助手。"""
    agents = {a['id']: a.get('backend') for a in call('GET', '/api/agents/management') if a.get('installed')}
    out = {}
    for a in call('GET', '/api/assistants'):
        backend = agents.get(a.get('agent_id'))
        if a.get('source') == 'generated' and backend in ORDER:
            out.setdefault(backend, a)
    return out


def model_names(model_id):
    """model 多实例入口的模型名带实例前缀（mp-q/claude/claude-opus-5-5、mp-codex/gpt-6.1-sol），
    路由组和自动路由写成 group/claude-…、auto/claude-…。统一换成网页按钮认的 claude/…、codex/… 名字，原名保留。"""
    parts = model_id.split('/')
    if len(parts) > 1 and parts[0].startswith('mp-'):
        parts = parts[1:]
    base = parts[-1]
    names = {model_id, '/'.join(parts)}
    if base.startswith('claude-'):
        names.add('claude/' + base)
    elif base.startswith('gpt-'):
        names.add('codex/' + base)
    return names


def key_models():
    """模型服务的模型列表按钥匙权限过滤；查不到时返回 None（Claude 保持打开，网页列出全部已知模型）。"""
    try:
        models = call('GET', '/v1/models', base=os.environ['ANTHROPIC_BASE_URL'],
                      headers={'x-api-key': os.environ['ANTHROPIC_API_KEY'], 'anthropic-version': '2023-06-01'})
        return sorted({n for m in models.get('data', []) for n in model_names(str(m.get('id', '')))})
    except Exception as e:
        print(f'查不到模型权限（{type(e).__name__}），Claude 保持打开', file=sys.stderr)
        return None


def engine_efforts():
    """引擎自己的默认推理强度（对话没写推理强度时实际用的值），网页输入框下面的按钮按它显示。"""
    out = {}
    try:
        out['claude'] = json.load(open('/data/.claude/settings.json')).get('effortLevel')
    except Exception:
        pass
    try:
        for line in open(os.path.join(os.environ.get('CODEX_HOME', '/data/.codex'), 'config.toml')):
            k, _, v = line.partition('=')
            if k.strip() == 'model_reasoning_effort':
                out['codex'] = v.strip().strip('"')
                break
    except OSError:
        pass
    return {k: v for k, v in out.items() if v}


# 后端启动时检测 PATH 上的 codex、claude；等两者都出现（最多约 30 秒）。
for _ in range(30):
    found = bare()
    if len(found) == len(ORDER):
        break
    time.sleep(1)
if not found:
    sys.exit('找不到 Codex 和 Claude Code 助手')
models = key_models()
if 'claude' in found and models is not None and not any(m.startswith(os.environ.get('PARTNER_CLAUDE_MODEL_PREFIX', 'claude')) for m in models):
    found.pop('claude')
    print('模型钥匙没有 Claude 权限，Claude 助手关闭')
keep = [found[b]['id'] for b in ORDER if b in found]

for a in call('GET', '/api/assistants'):
    want = a['id'] in keep
    state = {'enabled': want}
    if want:
        state['sort_order'] = -10 + keep.index(a['id'])
    if a.get('enabled') != want or (want and a.get('sort_order') != state['sort_order']):
        call('PATCH', f"/api/assistants/{a['id']}/state", state)
client = call('GET', '/api/settings/client') or {}
update = {'assistants.enabledOrder': keep}
if models is not None:
    update['wp.models'] = models
update['wp.effort'] = engine_efforts()
first = not os.path.exists(FIRST_RUN)
if first or client.get('guid.lastAssistantId') not in keep:
    update['guid.lastAssistantId'] = keep[0]
if first:
    call('PATCH', '/api/settings', {'language': os.environ.get('PARTNER_DEFAULT_LANGUAGE', 'zh-CN')})
call('PUT', '/api/settings/client', update)
if first:
    open(FIRST_RUN, 'w').close()
print('助手：' + '、'.join(keep) + f"；默认 {update.get('guid.lastAssistantId', client.get('guid.lastAssistantId'))}")

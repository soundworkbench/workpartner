/** Render the company authorization page, shared by gateway and desktop.
 * @param options A local desktop page sets local=true; the gateway page uses the default false.
 * @returns A standalone Chinese settings document containing no credentials.
 */
export function authorizationPage({ local = false, appearanceStyle = "[hidden]{display:none!important}body{margin:0;background:#f5f5f5;color:#222;font:16px/1.6 system-ui,\"Microsoft YaHei\",sans-serif}main{max-width:640px;margin:48px auto;padding:0 24px}h1{color:#333;font-size:28px}section{background:white;padding:24px;border:1px solid #ddd;border-radius:16px;margin:20px 0}h2{font-size:20px;margin:0 0 8px}p{color:#666}button,a.button{border:0;border-radius:8px;padding:10px 18px;background:#333;color:white;font:inherit;cursor:pointer;display:inline-block;text-decoration:none;margin:4px 8px 4px 0}button.secondary{background:#eee;color:#333}button:disabled{opacity:.5;cursor:wait}a{color:#333}#error{color:#a32336;white-space:pre-wrap}#project-link{overflow-wrap:anywhere}button:focus-visible,a:focus-visible{outline:3px solid #777;outline-offset:3px}" } = {}) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书授权 · 工作伙伴</title>
<style>${appearanceStyle}</style>
<main><h1>飞书授权</h1><p>连接后，工作伙伴可以使用你的身份处理飞书里的内容。发消息、发邮件、提交审批、删除和修改分享权限前，工作伙伴会先向你确认。</p>
<section><h2>飞书</h2><p id="feishu-status" role="status">正在检查授权…</p><a class="button" href="connect" id="connect">连接飞书</a><button class="secondary" id="disconnect" hidden>断开飞书</button></section>
<section><h2>飞书项目</h2><p>${local ? "此处连接本机的飞书项目。云端模式请在网页版连接。" : "此处连接云端工作伙伴的飞书项目。本机运行模式请在桌面版连接。"}</p><p id="project-status" role="status">正在检查授权…</p><button id="project-connect">连接飞书项目</button><button class="secondary" id="project-disconnect" hidden>断开飞书项目</button><p id="project-link"></p></section>
<p id="error" role="alert"></p><button class="secondary" id="refresh">刷新状态</button></main>
<script>
let pollTimer;
const byId = (id) => document.getElementById(id);
const showError = (error) => { byId('error').textContent = error.message; };
async function api(route, method = 'GET') {
  const r = await fetch(route, { method, credentials:'same-origin', headers: method === 'POST' ? {'content-type':'application/json'} : {} });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || '这项授权未处理完成，请查看连接状态；仍无法处理请联系管理员。');
  return data;
}
async function status() {
  byId('error').textContent = '';
  await Promise.all([
    api('status').then(s => { byId('feishu-status').textContent = !s.enabled ? '管理员已停用飞书授权' : s.revoking ? '已停止使用，远端撤销待完成，请重试断开' : s.connected ? '已连接' : '未连接'; byId('connect').hidden = !s.enabled || s.connected || s.revoking; byId('disconnect').hidden = !s.connected && !s.revoking; }).catch(showError),
    api('project/status').then(s => { byId('project-status').textContent = s.connected ? '已连接' : '未连接'; byId('project-connect').hidden = s.connected; byId('project-disconnect').hidden = !s.connected; }).catch(e => { byId('project-status').textContent = '暂时无法核实'; showError(e); })
  ]);
}
async function action(button, work) { button.disabled = true; try { await work(); } catch(e) { showError(e); } finally { button.disabled = false; } }
byId('disconnect').onclick = function() { if (confirm('断开后，工作伙伴将无法继续使用你的飞书授权。确认断开？')) action(this, async () => { await api('disconnect','POST'); await status(); }); };
byId('project-disconnect').onclick = function() { if (confirm('确认断开此处的飞书项目授权？')) action(this, async () => { clearTimeout(pollTimer); await api('project/disconnect','POST'); byId('project-link').replaceChildren(); await status(); }); };
byId('project-connect').onclick = function() { action(this, async () => { const p = await api('project/connect','POST'); const a = document.createElement('a'); a.href = p.authorization_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '打开飞书项目授权页面'; byId('project-link').replaceChildren(a, document.createTextNode(p.user_code ? ' 授权码：' + p.user_code : '')); byId('project-status').textContent = '等待你完成授权'; const poll = async () => { try { const r = await api('project/poll','POST'); if (r.state === 'connected') { byId('project-link').replaceChildren(); await status(); } else if (r.state === 'pending') pollTimer = setTimeout(poll, p.interval * 1000); else { byId('project-status').textContent = '授权已过期，请重新连接'; } } catch(e) { showError(e); } }; clearTimeout(pollTimer); pollTimer = setTimeout(poll, p.interval * 1000); }); };
byId('refresh').onclick = status;
window.addEventListener('pagehide', () => clearTimeout(pollTimer));
status();
</script></html>`;
}

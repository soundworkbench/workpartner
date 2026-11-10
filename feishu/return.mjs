/** A fixed app return destination; no OAuth code, identity or token is sent to the opener.
 * @param popup True only when the validated OAuth state requested a popup return.
 * @returns A completion document which closes the popup or reopens native settings.
 */
export function completionPage(popup) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书授权已完成</title><style>body{font:16px/1.6 system-ui;padding:32px;color-scheme:light dark}</style><p>飞书授权已完成，可以回到工作伙伴。</p><a href="/?zp-settings=feishu">回到飞书授权设置</a><script>
if (${JSON.stringify(popup)} && window.opener) {
  window.opener.postMessage({type:'workpartner.identity.connected'}, location.origin);
  window.close();
} else {
  sessionStorage.setItem('zp-feishu-return', '1');
  location.replace('/?zp-settings=feishu');
}
</script></html>`;
}

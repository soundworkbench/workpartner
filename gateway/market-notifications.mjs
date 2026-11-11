/** Application-bot messages carry review links; decisions require a fresh authenticated approval page. */
import fs from 'node:fs';

/** Create review and result senders. Application credentials are read only when a notification is requested. */
export function marketNotifications(organization, fetcher = fetch) {
  async function send(unionId, type, content) {
    async function request(route, body, token) {
      const response = await fetcher(`https://open.feishu.cn/open-apis${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' });
      const data = await response.json(); if (!response.ok || data.code) throw new Error('Bot notification unavailable');
      return data;
    }
    const auth = await request('/auth/v3/tenant_access_token/internal', { app_id: organization.identity.appId,
      app_secret: fs.readFileSync(organization.identity.appSecretFile, 'utf8').trim() });
    if (!auth.tenant_access_token) throw new Error('Bot authentication unavailable');
    await request('/im/v1/messages?receive_id_type=union_id', { receive_id: unionId, msg_type: type, content: JSON.stringify(content) }, auth.tenant_access_token);
  }
  return {
    async notify(row) {
      const url = `${organization.server.publicOrigin}/_wp/market/shared/review?name=${encodeURIComponent(row.name)}&version=${encodeURIComponent(row.version)}`;
      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '技能待审批' } }, elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `${row.displayName}\n${row.description}\n作者：${row.author}\n含脚本 ${row.scripts} 个\n例句：${row.example}` } },
        ...row.warnings.map(warning => ({ tag: 'markdown', content: '<font color="red">' + warning + '</font>' })),
        { tag: 'action', actions: ['批准', '拒绝'].map((label, index) => ({ tag: 'button', type: index ? 'default' : 'primary', text: { tag: 'plain_text', content: label }, url: url + '&action=' + (index ? 'reject' : 'approve') })) },
      ] };
      const sent = await Promise.allSettled(row.approvers.map(id => send(id, 'interactive', card)));
      if (sent.some(result => result.status === 'rejected')) throw new Error('Some approval cards were not delivered');
    },
    notifyAuthor(row) { return send(row.unionId, 'text', { text: `技能审批结果\n${row.displayName}：${row.status === 'approved' ? '已批准上架' : '未通过审批'}${row.reason ? '\n原因：' + row.reason : ''}` }); },
  };
}

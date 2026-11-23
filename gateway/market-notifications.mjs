/** Feishu review and author notifications for the shared skill market. */
import fs from 'node:fs';

export function marketNotifications(organization, fetcher = fetch) {
  async function send(unionId, type, content) {
    async function request(route, body, token) {
      const response = await fetcher(`https://open.feishu.cn/open-apis${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' });
      const data = await response.json(); if (!response.ok || data.code) throw new Error('Bot notification unavailable'); return data;
    }
    const auth = await request('/auth/v3/tenant_access_token/internal', { app_id: organization.identity.appId, app_secret: fs.readFileSync(organization.identity.appSecretFile, 'utf8').trim() });
    if (!auth.tenant_access_token) throw new Error('Bot authentication unavailable');
    await request('/im/v1/messages?receive_id_type=union_id', { receive_id: unionId, msg_type: type, content: JSON.stringify(content) }, auth.tenant_access_token);
  }
  const versionText = row => row.semver ? `v${row.semver}` : '未标注';
  const reasons = row => (row.manualReasons || []).map(item => item.file ? `${item.file} 第 ${item.line} 行：${item.label}` : `${item.label || item.rule}`).join('；');
  return {
    async notify(row) {
      const base = `${organization.server.publicOrigin}/_wp/market/shared/review?name=${encodeURIComponent(row.name)}&version=${encodeURIComponent(row.version)}`;
      const approve = row.reviewToken ? `${base}&action=approve&t=${encodeURIComponent(row.reviewToken)}` : `${base}&action=approve`;
      const reject = `${base}&action=reject`;
      const updating = Boolean(row.hasLive);
      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: updating ? '技能更新待审批（自动审核未通过）' : '新技能待审批' } }, elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `${row.displayName}\n${row.description}\n作者：${row.author}\n版本：${versionText(row)}${row.hasLive ? `\n当前上架：${row.currentSemver ? `v${row.currentSemver}` : '未标注'}` : ''}\n含脚本 ${row.scripts} 个\n例句：${row.example}` } },
        ...(row.warnings || []).map(warning => ({ tag: 'markdown', content: '<font color="red">' + warning + '</font>' })),
        ...(row.manualReasons || []).map(reason => ({ tag: 'markdown', content: `文件 ${reason.file || ''} 第 ${reason.line || ''} 行：${reason.label || reason.rule}` })),
        { tag: 'action', actions: [
          { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '批准并发布' }, url: approve },
          { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '拒绝' }, url: reject },
        ] },
      ] };
      const sent = await Promise.allSettled((row.approvers || []).map(id => send(id, 'interactive', card))); if (sent.some(result => result.status === 'rejected')) throw new Error('Some approval cards were not delivered');
    },
    notifyAuthor(row) {
      const v = versionText(row), why = reasons(row);
      let text;
      if (row.autoPublished) text = `技能「${row.displayName}」${v} 已自动审核通过并发布，同事新开对话即可用新版。`;
      else if (row.status === 'pending') text = `技能「${row.displayName}」${v} 未通过自动审核，已转 IT 审批。${why ? `原因：${why}` : ''}`;
      else if (row.status === 'approved') text = `技能「${row.displayName}」${v} 已批准上架`;
      else text = `技能审批结果\n${row.displayName} ${v}：未通过审批${row.reason ? `\n原因：${row.reason}` : ''}`;
      return send(row.unionId, 'text', { text });
    },
  };
}

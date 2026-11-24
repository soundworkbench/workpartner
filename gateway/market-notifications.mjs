/** Feishu review and author notifications for the shared skill market. */
import fs from 'node:fs';

export function marketNotifications(organization, fetcher = fetch) {
  async function send(unionId, type, content) {
    async function request(route, body, token) {
      const response = await fetcher(`https://open.feishu.cn/open-apis${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok || data.code) throw new Error('Bot notification unavailable');
      return data;
    }
    const auth = await request('/auth/v3/tenant_access_token/internal', {
      app_id: organization.identity.appId,
      app_secret: fs.readFileSync(organization.identity.appSecretFile, 'utf8').trim(),
    });
    if (!auth.tenant_access_token) throw new Error('Bot authentication unavailable');
    await request('/im/v1/messages?receive_id_type=union_id', {
      receive_id: unionId,
      msg_type: type,
      content: JSON.stringify(content),
    }, auth.tenant_access_token);
  }

  const versionText = row => row.semver ? `v${row.semver}` : '未标注';
  const reasonText = reason => reason.file && reason.line
    ? `文件 ${reason.file} 第 ${reason.line} 行：${reason.label || reason.rule}`
    : reason.label || reason.rule;
  const reasons = row => (row.manualReasons || []).map(reasonText).join('；');
  const reviewUrl = row => `${organization.server.publicOrigin}/_wp/market/shared/review`
    + `?name=${encodeURIComponent(row.name)}&version=${encodeURIComponent(row.version)}`;

  return {
    async notify(row) {
      const base = reviewUrl(row);
      const approve = row.reviewToken
        ? `${base}&action=approve&t=${encodeURIComponent(row.reviewToken)}`
        : `${base}&action=approve`;
      const reject = `${base}&action=reject`;
      const updating = Boolean(row.hasLive);
      const content = [
        `${row.displayName}`,
        row.description,
        `作者：${row.author}`,
        `版本：${versionText(row)}`,
        ...(row.hasLive ? [`当前上架：${row.currentSemver ? `v${row.currentSemver}` : '未标注'}`] : []),
        `含脚本 ${row.scripts} 个`,
        `例句：${row.example}`,
      ].join('\n');
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: {
            tag: 'plain_text',
            content: updating ? '技能更新待审批（自动审核未通过）' : '新技能待审批',
          },
        },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content } },
          ...(row.warnings || []).map(warning => ({
            tag: 'markdown',
            content: `<font color="red">${warning}</font>`,
          })),
          // Feishu cards reject a bare plain_text block; wrap it in div so reasons stay plain text.
          ...(row.manualReasons || []).map(reason => ({
            tag: 'div',
            text: { tag: 'plain_text', content: reasonText(reason) },
          })),
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                type: 'primary',
                text: { tag: 'plain_text', content: '查看并批准' },
                url: approve,
              },
              {
                tag: 'button',
                type: 'default',
                text: { tag: 'plain_text', content: '拒绝' },
                url: reject,
              },
            ],
          },
        ],
      };
      const sent = await Promise.allSettled((row.approvers || []).map(id => send(id, 'interactive', card)));
      if (sent.some(result => result.status === 'rejected')) throw new Error('Some approval cards were not delivered');
    },

    async notifyAuto(row) {
      const files = row.changedFiles || [];
      const listed = files.slice(0, 20);
      const fileText = listed.join('\n') + (files.length > listed.length ? `\n等 ${files.length - listed.length} 个` : '');
      const version = versionText(row);
      const content = [
        `技能名：${row.name || row.displayName}`
          + (row.name && row.displayName && row.name !== row.displayName ? `（${row.displayName}）` : ''),
        `版本：${version}`,
        `作者：${row.author}`,
        '相对上一版改动的文件：',
        fileText || '（无文件改动）',
      ].join('\n');
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '技能已自动发布' } },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content } },
          { tag: 'action', actions: [{
            tag: 'button', type: 'default', text: { tag: 'plain_text', content: '查看 / 下架' }, url: reviewUrl(row),
          }] },
        ],
      };
      const sent = await Promise.allSettled((row.approvers || []).map(id => send(id, 'interactive', card)));
      if (sent.some(result => result.status === 'rejected')) throw new Error('Some automatic publication cards were not delivered');
    },

    notifyAuthor(row) {
      const version = versionText(row);
      const why = reasons(row);
      let message;
      if (row.autoPublished) {
        message = `技能「${row.displayName}」${version} 已自动审核通过并发布，同事新开对话即可用新版。`;
      } else if (row.status === 'pending') {
        message = `技能「${row.displayName}」${version} 未通过自动审核，已转 IT 审批。${why ? `原因：${why}` : ''}`;
      } else if (row.status === 'approved') {
        message = `技能「${row.displayName}」${version} 已批准上架`;
      } else {
        message = `技能审批结果\n${row.displayName} ${version}：未通过审批${row.reason ? `\n原因：${row.reason}` : ''}`;
      }
      return send(row.unionId, 'text', { text: message });
    },
  };
}

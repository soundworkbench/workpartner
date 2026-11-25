# T-1450 网关热修：桌面取钥匙空 fp、桌面路由响应后返回值

仓库：soundworkbench/workpartner（本 worktree），基于 origin/main（含 T-1446，提交 13db379）。只改 `gateway/desktop-auth.mjs` 和 `gateway/tests/desktop-auth.test.mjs`。

## 背景（线上必现故障）
CRY AI 工具箱桌面客户端登录成功后，首次同步调用 `GET /_wp/api/desktop/key?fp=`（本机还没有钥匙，fp 为空字符串）。`gateway/desktop-auth.mjs` 约 219 行：
`if (fp !== null && !/^[a-f0-9]{12}$/i.test(fp)) return fail(res, 400, 'invalid_fingerprint');`
空字符串不是 null，被判 400，客户端永远拿不到钥匙。

## 必改
1. 空字符串 `fp` 视同未带 fp：`fp=` 和不带 fp 行为完全一致（有钥匙返回 200 + key）。非空但格式不对仍返回 400 invalid_fingerprint。
2. `handle()` 在已写出响应的所有分支都必须返回真值（现在 `json()`/`page()`/`fail()` 返回 undefined，`return fail(...)` 让 handle 返回 undefined，`gateway/gateway.mjs` 第 329 行 `if (await desktopAuth(req, res, url)) return;` 不返回，继续走后续路由，线上日志反复出现「Cannot write headers after they are sent to the client」）。最小改法：让 `json`、`page` 返回 `true`，`fail` 返回 `json(...)` 的结果；未命中桌面路由仍返回 `false`。不要改 gateway.mjs。
3. 测试（`gateway/tests/desktop-auth.test.mjs`）：
   - 登录换到令牌后，`/_wp/api/desktop/key?fp=` 返回 200 且带 key；不带 fp 同样 200。
   - `fp=xyz` 仍 400。
   - 对 AUTHORIZE 的 400 页、TOKEN 的 400 invalid_grant、KEY 的 401、REFRESH 的 401、REVOKE、成功 200 这些分支，直接调用 handle 时断言返回值为 true（严格 `=== true`）；对非桌面路径返回 false。

## 不做
- 不改协议、不改其他路由、不改 gateway.mjs。

## 验证
沙箱若无 node，写明协调者要跑的命令：`node --test gateway/tests/desktop-auth.test.mjs`。能跑就自己跑通。不要 git 提交。报告追加到本任务文件夹 report.md：改了什么、测试结果。

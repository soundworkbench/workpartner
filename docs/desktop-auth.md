# 桌面版登录接口

桌面客户端使用 `https://workpartner.corp.crysound.com` 完成飞书登录、PKCE 换取桌面令牌，并读取当前用户在「我的钥匙」中的钥匙。桌面版默认关闭，只有 `organization.json` 的 `desktop.enabled` 为 `true` 且用户匹配 `desktop.allow` 时开放；名单元素可以是用户 `slug`、飞书 `unionId` 或 `"*"`。

## 登录和令牌

客户端先打开：

`GET /_wp/desktop/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcb&code_challenge=...&code_challenge_method=S256&state=...`

`redirect_uri` 必须是本机 `127.0.0.1`、1024–65535 端口的 `/cb`，不能有查询参数或片段。`code_challenge` 是 43 位 base64url 字符串，方法固定为 `S256`，`state` 是 1–256 个可见 ASCII 字符。未登录时网关会转到现有飞书登录，登录完成后回到该地址。成功时只使用一次、60 秒有效的 code 会通过 302 返回到 `redirect_uri`，并原样带回 URL 编码后的 `state`。

随后发送不带 cookie、也不要求 `Origin` 的 JSON 请求：

`POST /_wp/api/desktop/token`

```json
{"code":"…","code_verifier":"…","redirect_uri":"http://127.0.0.1:12345/cb","device_name":"CRY AI 工具箱"}
```

成功返回 `{access_token, expires_at, user:{union_id,name,avatar?}}`。code 过期、重放、校验失败或回调地址不一致都返回 400，并作废该 code。令牌只用于桌面接口，不能替代 `wp_sid` 或 `zpd`。

令牌到期前可用 `POST /_wp/api/desktop/refresh` 和 `Authorization: Bearer <access_token>` 换取新令牌。用户被移出 `users.json`、移出 `desktop.allow`、令牌过期或管理员执行撤销后，刷新返回 401。

## 读取钥匙和撤销

`GET /_wp/api/desktop/key` 使用桌面令牌读取钥匙，成功返回 `{key,fingerprint,base_url,issued_at}`。`fingerprint` 是钥匙 SHA-256 的前 12 位十六进制，`base_url` 来自 `myKey.publicBaseUrl`，`issued_at` 是钥匙文件修改时间。客户端已保存相同指纹时传 `?fp=…`，网关返回 204。此接口同时要求 `desktop.allow` 和 `myKey.allow`，无钥匙返回 404，按人限频返回 429 和 `Retry-After`。响应禁止缓存；审计只保存时间、unionId、设备名和指纹，不保存明文钥匙。

`POST /_wp/api/desktop/revoke-all` 可用桌面令牌调用，也可由网页登录态在同源 `Origin` 下调用，成功返回 `{"ok":true}`。它会把此人的持久化代次号加一，使已有桌面令牌立即失效。「我的钥匙」页面在桌面版开放时显示“退出所有桌面设备”按钮。

代次号写入 `${runtime.stateDirectory}/desktop-auth/generations.json`，临时文件原子替换。一次性 code 只保存在当前网关进程内；多副本部署需要在同一实例完成授权和换 token，或后续接入共享的一次性 code 存储。


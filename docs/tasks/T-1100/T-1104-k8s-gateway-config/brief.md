# T-1104 k8s 网关补配置缺口

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，代码和文档里不得出现公司名、IP、域名、主机名、人名，示例用 example.com / 192.0.2.x。

## 背景
按 docs/kubernetes.md 渲染出的 k8s 网关 Deployment 只传 `WORKPARTNER_ORG_DIR`。生产组织目录里没有 publicHost 等字段（以前都靠 Docker compose 的 env 注入），于是：
- `resolveOrganization`（gateway/organization/resolve.mjs:102-117）里 `PREVIEW_HOST`、`OLD_HOSTS`、`MEEGLE_HOST` 只认 env，k8s 下无法配置 → 预览域名、旧域名在 Host 检查处返回 403。
- 模型出口（规格决策 13）只支持 `deploy.modelEgressSelector`（集群内 Pod）。现实中模型出口暂时是节点宿主机网桥上发布的一个固定 `IP:端口`；Pod 直连 Docker 容器 IP 会被 Docker raw 规则丢弃，必须连网桥地址。

## 要做
1. resolve.mjs：组织 JSON 支持 `previewHost`、`legacyHosts`（字符串数组）、`projectHost`（对应 MEEGLE_HOST）三个字段，env 优先、JSON 兜底，与 publicHost 现有写法一致；hostname 校验规则沿用。更新 schema/校验（若有）、docs/kubernetes.md 和 docs/deployment.md 的字段表。
2. render.mjs：新增可选 `runtime.k8s.deploy.modelEgressEndpoint: { address: "<IPv4>", port: <1-65535> }`，与 `modelEgressSelector` 二选一（都配或都不配时报错，沿用现有错误风格）。配了 endpoint 时：
   - 渲染 selector-less Service（名字、端口与 model.nextBaseUrl 的主机名、端口一致，与现在 selector 版本同名同端口）+ 一个 EndpointSlice（`kubernetes.io/service-name` 标签、addressType IPv4）指向该地址；
   - 用户命名空间的出站 NetworkPolicy 额外放行到 `<address>/32` 的该 TCP 端口（即使地址落在默认排除的私网段内）；只放行这一个地址端口，不放宽其他私网；
   - address 必须是 IPv4 字面量，不能是 0.0.0.0、回环、链路本地、169.254.169.254；
   - 现有「baseUrl 与 nextBaseUrl 主机端口一致」校验保持。
3. 组织 JSON 有上述字段时，渲染结果应能直接工作，不需要手工往 Deployment 补 env。
4. 测试：resolve 的 JSON 兜底与 env 优先；render 的 endpoint 版本输出（Service 无 selector、EndpointSlice 内容、NetworkPolicy 新增的精确放行）、二选一报错、非法地址报错。现有测试全部保持通过：`node --test tools/`，仓库若有 `tools/check.sh` 也要全过。
5. 不改 loadGatewayExtension 的默认值；在 docs/kubernetes.md 写清：需要组织扩展提供的路由时设为 true，扩展不能依赖 Docker 传输。

## 交付
report.md 追加：改动摘要、测试输出摘要、渲染样例片段（示例地址）。不要提交 git。

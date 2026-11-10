# T-1103 e2e 工作流：修 k3d 校验和读取

仓库：公开仓库 workpartner（本 worktree），基准 main。公开仓库，代码和文档里不得出现公司名、IP、域名、主机名、人名。

## 现象
`.github/workflows/e2e-k3d.yml` 在 GitHub 上用 `workflow_dispatch` 实际运行，步骤「Install versioned tools and verify SHA256」里 kubectl 显示 `kubectl: OK`，随后输出 `Missing or ambiguous k3d SHA256` 并退出 1。k3d v5.8.3 的发布文件和 checksum 文件格式与脚本假设不一致（例如 checksums 文件里同名条目不唯一、文件名带路径前缀），本来就该直接用 env 里钉死的 K3D_SHA256。

## 要做
1. 找到报错的代码（工作流内联脚本或 tools/k8s/e2e/ 下的脚本），改成：下载 `k3d-linux-amd64` 后直接用 env 中钉死的 `K3D_SHA256` 做 `sha256sum -c`，不依赖上游 checksums 文件的格式。kubectl 保持钉死校验。校验不符必须失败。
2. 工作流输入 `external_probe`：值不是 `host:port` 时在最前面的步骤给出清楚的英文报错，说明期望格式示例 `192.0.2.1:443`。
3. 安装校验逻辑如果抽成脚本，要在 `tools/k8s/e2e/tests/` 下加能离线跑的测试（本地假文件和假 SHA：相符通过、不符失败、SHA 为空失败）。
4. actionlint：`docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.7 -no-color .github/workflows/e2e-k3d.yml` 退出码 0（沙箱里跑不了 docker 就写明，由协调者跑）。
5. `node --test tools/k8s/e2e/tests/` 全过；仓库若有 `tools/check.sh` 也要全过。

## 交付
report.md 追加：根因、改了哪些行、测试输出摘要。不要提交 git。

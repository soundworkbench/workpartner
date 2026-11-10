# T-1104 实施记录

## 改动摘要

- `resolveOrganization` 从组织 JSON 读取 `previewHost`、`legacyHosts`（字符串数组）、`projectHost`；非空 `PREVIEW_HOST`、`OLD_HOSTS`、`MEEGLE_HOST` 优先，空环境值回退 JSON。沿用 hostname 校验，保留 OLD_HOSTS 的逗号拆分和去空白行为；补齐类型声明。
- `runtime.k8s.deploy.modelEgressEndpoint` 与 `modelEgressSelector` 必须且只能配置一个。endpoint 校验 IPv4 字面量和整数端口 1–65535，拒绝未指定、回环、链路本地及元数据地址。保留 baseUrl/nextBaseUrl 同主机同端口校验。
- endpoint 模式输出无 selector 的模型 Service 和 `discovery.k8s.io/v1` EndpointSlice。Service 名称及端口沿用模型 URL；目标端口取 endpoint.port。用户出站策略增加目的地址 `/32`、单个 TCP 端口的规则，完整保留现有私网及节点地址排除项。模型 Pod 入站策略仅在 selector 模式生成，避免空 selector 匹配其他系统 Pod。
- `--only` 支持 EndpointSlice；更新 Kubernetes 重渲染命令，避免遗漏该对象。组织 JSON 的域名配置可直接通过现有只读挂载读取，无需修改 Deployment env。
- 更新 Kubernetes 与 deployment 字段表及示例。`loadGatewayExtension` 默认值未改；明确需要组织扩展路由时设为 true，扩展不能依赖 Docker 传输。
- 未提交 git；未访问或修改实际集群。示例仅使用保留域名和文档地址；测试中的特殊地址用于校验保留网段规则。

## 测试输出摘要

- `node tools/organization-resolve.test.mjs`：4 tests，4 pass，0 fail。
- `node tools/k8s-render.test.mjs`：56 tests，56 pass，0 fail（包括既有用例、新 endpoint 输出、精确出站规则、互斥及非法配置用例，以及只使用组织目录的 CLI 渲染/解析验证）。
- `node --test tools/organization-resolve.test.mjs tools/k8s-render.test.mjs`：2 个测试文件通过，0 fail。
- `git diff --check`：通过。
- 已执行要求的 `node --test tools/`：当前环境 Node v22.22.1 报 `MODULE_NOT_FOUND`，将 tools 目录当作模块路径；未运行到测试用例。随后按仓库 check.sh 的文件列表尝试 `tools/*.test.mjs`。
- 已执行 `bash tools/check.sh`：此前 JavaScript/Python/shell 语法检查通过；在既有 `tools/wp-seed.test.py` 的本地 HTTP 服务测试处失败，沙箱禁止创建监听 socket，报 `PermissionError: [Errno 1] Operation not permitted`。
- `node --test --test-timeout=30000 tools/*.test.mjs`：13 个文件，5 pass、4 fail、4 cancelled（超时）。全量 JavaScript 检查还遇到缺少 `ws` 包及部分既有测试超时。直接运行失败文件确认 gateway/identity-cli 测试报 `listen EPERM`，runtime-models 测试报 `listen EPERM` 及 `chown/fchown EINVAL`。没有放宽沙箱、跳过断言或修改测试以掩盖失败。当前不能声称两套全量检查全过，需在依赖齐全且允许本地监听的测试环境完成验收。

## 实际离线渲染片段

输入片段（与完整部署配置合并，省略 modelEgressSelector）：

```json
{
  "publicHost": "workspace.example.com",
  "previewHost": "preview.example.com",
  "legacyHosts": ["old.example.com"],
  "projectHost": "project.example.com",
  "model": {
    "baseUrl": "http://model-egress:4000/v1",
    "nextBaseUrl": "http://model-egress:4000/v1"
  },
  "runtime": {
    "k8s": {
      "deploy": {
        "modelEgressEndpoint": { "address": "192.0.2.10", "port": 4100 }
      }
    }
  }
}
```

以下对象由 `renderManifests` 实际生成（JSON 文档也是合法 YAML）：

```yaml
{
  "apiVersion": "v1",
  "kind": "Service",
  "metadata": {
    "name": "model-egress",
    "namespace": "fixture-system",
    "labels": {
      "app.kubernetes.io/part-of": "workpartner"
    }
  },
  "spec": {
    "type": "ClusterIP",
    "ports": [
      {
        "name": "model",
        "protocol": "TCP",
        "port": 4000,
        "targetPort": 4100
      }
    ]
  }
}
---
{
  "apiVersion": "discovery.k8s.io/v1",
  "kind": "EndpointSlice",
  "metadata": {
    "name": "model-egress",
    "namespace": "fixture-system",
    "labels": {
      "app.kubernetes.io/part-of": "workpartner",
      "kubernetes.io/service-name": "model-egress",
      "endpointslice.kubernetes.io/managed-by": "workpartner-render"
    }
  },
  "addressType": "IPv4",
  "ports": [
    {
      "name": "model",
      "protocol": "TCP",
      "port": 4100
    }
  ],
  "endpoints": [
    {
      "addresses": [
        "192.0.2.10"
      ],
      "conditions": {
        "ready": true
      }
    }
  ]
}
```

用户命名空间 `workpartner-user-egress.spec.egress` 中的模型规则：

```json
{
  "to": [
    {
      "ipBlock": {
        "cidr": "192.0.2.10/32"
      }
    }
  ],
  "ports": [
    {
      "protocol": "TCP",
      "port": 4100
    }
  ]
}
```

测试同时核对其余出站规则与 selector 版本完全相同，并逐一验证默认排除的私网/共享地址范围中仍仅新增单个地址端口例外。离线渲染及断言不代表实际 CNI、节点防火墙和网桥服务的连通性验收。

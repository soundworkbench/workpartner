# Organization configuration

`WORKPARTNER_ORG_DIR` selects the organization directory. The neutral configuration is in `org/default/organization.json`; its schema and the resolver in `gateway/organization/resolve.mjs` define the accepted fields. Copy the directory before customizing it. Store organization-specific values outside the source tree.

| Configuration group | Purpose |
| --- | --- |
| `displayName`, `productName` | Organization name and localized product names |
| `publicHost` | Your public HTTPS hostname and login callback host |
| `identity` | Provider, application identity, secret file reference and admission policy |
| `model` | Your model endpoint, key policy and agent defaults |
| `runtime` | Image, network, container names, limits and host data paths |
| `runtime.k8s.gatewayResources` | Optional gateway CPU and memory for the Kubernetes manifest renderer: `{"cpu":"500m","memory":"512Mi"}`. Each omitted field keeps that default. Values are positive Kubernetes resource quantity strings; requests and limits use the same values to retain Guaranteed QoS. |
| `appearance` | Neutral or custom assets and interface copy |
| `image` | Optional skills and instruction templates |
| `bridge` | Optional organization-owned messaging bridge template |

Set the public hostname and model endpoint explicitly. Give the login application its own credentials and reference secret files instead of placing secrets in JSON. The default configuration contains no organization accounts, admission group, private model endpoint, preinstalled organization skills or enabled messaging bridge. Branding assets and instructions belong to the selected organization directory.

`identity.callbackPath` selects the callback already registered with the login provider. It defaults to `/_wp/callback`; an organization using a transitional gateway extension can retain its previous callback. Login and personal platform authorization use the same setting. State cookies cover both route namespaces; the extension maps the previous callback to the public handler.

The gateway reads `model.defaults` and the optional `model.catalog` from its mounted organization on each personal-container check. It passes the non-secret defaults and catalog in `WORKPARTNER_MODEL_CONFIG`. A changed configuration uses the existing idle-container replacement policy, even when the image name and image ID are unchanged. Active conversations delay replacement until idle under the same maximum deferral policy as image upgrades. No image rebuild or gateway restart is needed for subsequent model changes. A page request or the existing rollout tool triggers the check; refresh the page after the replacement.

For example, edit `model.defaults.claude` and `model.defaults.opus` in your mounted `organization.json`, then access an idle personal workspace. The replaced container receives the new Claude default and alias mapping. The other Claude aliases are `sonnet` and `haiku`; the neutral defaults are `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. ChatGPT (Codex) defaults to `gpt-6.1-sol`. Engine model values follow changed organization defaults while they still equal the last organization value recorded in `.wp-organization-model.json` beside each engine configuration. Personal model changes, browser selections and conversation selections remain in effect. Markerless existing settings adopt the current default or the released initial default (`claude/claude-opus-5-5` for Claude and `gpt-6.1-sol` for Codex); other values are preserved.

At startup the resolver uses the injected configuration, falling back to the embedded organization only when none was supplied. Invalid injected configuration stops startup. First-run engine files use those runtime values. The seed publishes the runtime catalog and personal engine defaults through the existing `/api/settings/client` settings; the browser no longer embeds a model catalog in its build. A failed `/v1/models` permission lookup retains that runtime catalog.

Without `model.catalog`, the catalog has one configured default per engine. Optional entries are JSON arrays under `model.catalog.codex` and `model.catalog.claude`. An entry can reference a defaults field, such as `{ "default": "sonnet", "id": "sonnet" }`, or supply a literal `{ "id": "other-model", "key": "provider/other-model", "name": "Other model" }`. `also` lists native engine aliases for the same entry. Omit `name` on a default reference to display its configured model name. Put the intended default first. Catalog edits follow the same container replacement policy.

This code change requires one initial user-image rebuild and gateway deployment. Later model-default or catalog edits require only container replacement. Changes to branding, instructions or packaged software still require an image build.

Startup model discovery preserves the endpoint's route names and adds provider-qualified and bare names for catalog matching. This includes `provider/`, `group/`, `auto/` and `mp-*/` routes. The picker filters matching entries by those permissions and the engine's supported options, while keeping the current model visible. If permission matching removes every available catalog entry, it restores the engine-supported catalog instead of showing only the current model.

Set `bridge.template` to a template relative to the organization directory. The build renders model and effort placeholders and embeds the template; bot credentials remain outside the image. The image includes the bridge onboarding worker and authorization overlays; their HTTP endpoints are provided by the deployment gateway. Startup launches the bridge only when `/data/.cc-connect/config.toml` already exists. The pinned customized binary supports the template's preview and thread isolation options. The public downloader verifies its release digest; see [build input limits](deployment.md#current-preview-limits).

`image.homeDirectory` supplies organization home templates, including an optional `feishu-SKILL.md` authorization policy. `image.instructions` supplies the company instruction block; `image.legacyInstructions` supplies exact historical templates. Startup replaces only the marked company block in personal instructions, preserving the surrounding bytes; pristine historical templates upgrade in full. Existing `AGENTS.md` files remain intact.

`image.skillTranslations` overrides entries from the generic `image/skills-zh.json`. `image.officialSkillsArchive` enables the official skill bundle. The public build supplies its reproducible archive from the two locked upstream source archives; direct materialization copies the configured local archive unless `WORKPARTNER_OFFICIAL_SKILLS_ARCHIVE` explicitly supplies a replacement. The installer retains references and licenses and groups the official skills under the generic `feishu` skill in the capability list. Organization-specific authorization instructions belong in the organization home policy.

`runtime.kind` selects the gateway's container runtime at startup: `"docker"` (the default) or `"k8s"`. Any other value stops gateway startup with an unsupported-runtime error. Docker preserves the current images, owner UID, mounts, resource limits, restart policy and per-user networks, including the `wpn-` bridge-name prefix used by host firewall rules. Container lifecycle, command execution, personal-volume file access and endpoint resolution go through this runtime.

The [Kubernetes operations guide](kubernetes.md) lists every Kubernetes and migration field, its consumer-side default, naming rules, deployment manifests, migration commands and recovery steps. `resolve.mjs` recursively merges organization JSON with the neutral defaults; it does not fill in `runtime.k8s` or `runtime.migration`, and there are no dedicated environment overrides for these fields. Docker-only organizations may omit them.

Kubernetes requires `runtime.k8s.namespace` for user workloads and `runtime.k8s.storageClass` for new data volumes. `runtime.k8s.systemNamespace` selects the namespace for system Pods and the image registry ConfigMap; it defaults to the client's namespace (the ServiceAccount namespace in-cluster, the selected context namespace with JSON kubeconfig). Set it explicitly for offline manifest rendering. Optional `runtime.k8s.systemContainer` names the container used by `execNamed(name)` in that system namespace. It must be a nonempty DNS label. When omitted, the container name equals the target Pod name (`name`); set this field if the names differ. Personal `exec(slug)` always targets the `workspace` container.

During migration, configure both gateways with `runtime.migration.ownersFile` pointing to the same shared file and `runtime.migration.peerOrigin` pointing to the other gateway's internal HTTP origin. Without `ownersFile`, each gateway considers all users its own. With ownership enabled, non-AionUi users always belong to Docker. Kubernetes skips organization extensions by default and checks owned, existing, zero-replica workspaces every `runtime.k8s.keepRunningIntervalMs` (default 300000 ms; 0 disables it). The presence of the StatefulSet annotation `workpartner/paused` skips that background check; it does not block user-triggered startup.

The StatefulSet name (`runtime.nextContainerPrefix + slug`) must be a DNS label no longer than 52 characters, leaving room for the controller revision hash label and resource suffixes. Its Pod is named `<StatefulSet>-0`. Kubernetes `inspect` returns `replicas` from the StatefulSet specification and `annotations` from its metadata, defaulting to `null` and `{}` when absent. Its `address` is available only while the main container is running, has a Pod IP and is not terminating. These extra inspection fields do not change the Docker contract.

Workspace limits default to `runtime.nextMemory` (or 3221225472 bytes) and `runtime.nanoCpus / 1e9` (or 2 CPUs). The Kubernetes default CPU limit is 2 when `nanoCpus` is absent; Docker leaves it unlimited. Optional `runtime.k8s.userResources` overrides memory and/or CPU limits by slug when `create` builds or updates that person's workspace template. Values use Kubernetes resource quantities; unlisted users and omitted resources keep the global limits. Requests remain `runtime.k8s.memoryRequest` (default `512Mi`) and `runtime.k8s.cpuRequest` (default `100m`). For example, inside `runtime.k8s`, using a fictional slug:

```json
{
  "userResources": {
    "fixture-person": { "memory": "8Gi", "cpu": "2" }
  }
}
```

Repeated `create` preserves the current replica count and updates the template, clearing removed optional settings such as `runtime.k8s.userPriorityClass` and `runtime.k8s.newUserNodeSelector`. The StatefulSet uses `OnDelete`, so existing Pods need recreation to receive template changes. Model keys are mounted read-only from a Secret with `subPath`; updating the Secret also requires Pod recreation (for example, `restart`) before the new key becomes visible. One-off maintenance Pods retain the global limits and return at most 1 MiB of logs. `stop` and `remove` wait for all of the user's Pods to disappear; timeout errors name remaining Pods, and unrelated one-off Pods are not deleted automatically.

In Kubernetes mode every method on the legacy runtime throws `LegacyRuntimeUnavailable`. The following extension compatibility behavior applies to Docker deployments.

Organization-owned gateway extensions continue to receive the existing `docker(method, path, body, timeoutMs)` callback, returning `{status, body}` with a Buffer body. The synchronous `writeContainerToken(key, user, root='/users', uid=1001)` helper also remains available. New code can use the legacy personal runtime provided as `runtime` for `putFiles`, `readFile`, `removeFiles`, `exec`, `stop`, `remove`, and `address(slug, port, existing)` only. The legacy runtime does not expose other methods (including `inspect`, `create`, `runOnce`, and `ensureIsolation`); calling `address` without `existing` throws an unsupported-operation error. Use `personalRuntime` for the full next-container runtime. `writeContainerToken(key, user, runtime)` returns a Promise. Existing extensions can deploy without migration. Historical extension endpoints retain their supplied IP/address and port; an explicit `existing` value without an IP or address (including `null`) remains unavailable and does not trigger container discovery.

Configure reviewed sharing with `market.approvers`, `market.reservedPrefixes`, `market.sharedDirectory`, `market.containerDirectory` and `market.preinstalled`. See [skill market](skill-market.md) for mounts, review policy and acceptance. Empty approvers disable sharing.

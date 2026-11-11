#!/bin/bash
# 新版工作伙伴容器入口：AionUi 网页版 + JConnect 消息桥，两个入口共用 /data/work；引擎默认 Codex（界面叫 ChatGPT），可选 Claude Code。
# 钥匙只从只读挂载读进环境变量，不落盘。AionUi 只在容器网络里监听，入口只有网关。
set -u
export HOME=/data
# The image carries only its selected organization and non-secret configuration.
ORG_ENV=$(mktemp) || exit 1
if ! node /opt/workpartner/organization/resolve.mjs next-env > "$ORG_ENV"; then
  rm -f "$ORG_ENV"; exit 1
fi
. "$ORG_ENV"
rm -f "$ORG_ENV"
ANTHROPIC_API_KEY=$(cat "$PARTNER_MODEL_KEY_FILE") || { echo "读不到模型钥匙，请检查只读挂载" >&2; exit 1; }
export ANTHROPIC_API_KEY
export "$PARTNER_MODEL_KEY_ENV=$ANTHROPIC_API_KEY"
export DISABLE_AUTOUPDATER=1 CODEX_HOME=/data/.codex

mkdir -p /data/work /data/.claude/skills "$CODEX_HOME/skills" || exit 1
# AionUi 把上传的附件固定写到 /tmp/aionui：指到工作目录的“上传”文件夹，网页、文件栏和消息桥都看得到，容器重建也不丢。
# 同一容器里旧版留下的真实目录先并进去（不覆盖同名），再换成软链。
mkdir -p /data/work/上传 || exit 1
if [ -d /tmp/aionui ] && [ ! -L /tmp/aionui ]; then
  cp -an /tmp/aionui/. /data/work/上传/ && rm -rf /tmp/aionui || exit 1
fi
ln -sfnT /data/work/上传 /tmp/aionui || exit 1
# Follow organization defaults until the user chooses a different model.
python3 -I /opt/workpartner/bin/wp-model-defaults.py claude \
  /opt/workpartner/home/claude-settings.json /data/.claude/settings.json \
  "$ANTHROPIC_MODEL" "$PARTNER_DEFAULT_EFFORT" || exit 1
bash /opt/workpartner/agent-baseline/install.sh /data/.claude /data/.claude/hooks >/dev/null 2>&1 || echo "警告：防阻塞钩子没装上，继续启动" >&2
# Claude's environment model must agree with an existing personal selection.
ANTHROPIC_MODEL=$(python3 -I -c 'import json, os; print(json.load(open("/data/.claude/settings.json")).get("model") or os.environ["ANTHROPIC_MODEL"])') || exit 1
export ANTHROPIC_MODEL
cp -R /opt/workpartner/skills/. /data/.claude/skills/
# Codex links to the image skills; existing personal directories take priority.
for d in /opt/workpartner/skills/*/; do ln -sfnT "${d%/}" "$CODEX_HOME/skills/$(basename "$d")" 2>/dev/null; done
# Keep dangling company links: withdrawing a skill must not make a future startup adopt personal files.
# Broken skill links remain until explicitly removed; company links are managed by wp-skill.
python3 -I /opt/workpartner/bin/wp-market refresh-preinstalled || echo "警告：预装的共享技能暂不可用" >&2
# 引擎启动前校正早期模型名，再比较组织默认值。
if [ -f "$CODEX_HOME/config.toml" ]; then
  python3 -I /opt/workpartner/bin/wp-normalize-codex-model.py "$CODEX_HOME/config.toml" || echo "警告：未更新 Codex 配置，继续启动" >&2
fi
python3 -I /opt/workpartner/bin/wp-model-defaults.py codex \
  /opt/workpartner/home/codex-config.toml "$CODEX_HOME/config.toml" \
  "$PARTNER_CODEX_MODEL" "$PARTNER_DEFAULT_EFFORT" || exit 1
# 首次写整份说明；原样旧模板整份升级；个人说明只同步统一块，已有 AGENTS.md 不动。
if ! instructions_error=$(python3 -I /opt/workpartner/bin/wp-sync-instructions.py \
  /opt/workpartner/home/CLAUDE.md /data/work "${PARTNER_USER_NAME:-同事}" 2>&1); then
  printf '警告：%s；继续启动，下次启动重试。\n' "$instructions_error" >&2
fi

. /opt/workpartner/bin/wp-init-hooks.sh
wp_ensure_srv_directory
wp_init_hooks

cd /data/work
trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT
AIONUI_PORT=${AIONUI_PORT:-25808}
/opt/aionui/aionui-web start --static-dir /opt/aionui/static-wp --remote --port "$AIONUI_PORT" --no-open --data-dir /data/aionui-data &
service_pids=("$!")

# 每次启动校正助手（只开 ChatGPT 和 Claude，ChatGPT 排第一；没有 Claude 权限就只开 ChatGPT），第一次还写中文和默认助手。
# 失败不影响启动，下次启动重试。
for _ in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$AIONUI_PORT/api/assistants" && break; sleep 1; done
python3 -I /opt/workpartner/bin/wp-seed.py "http://127.0.0.1:$AIONUI_PORT"

# 消息桥：本人扫码建好机器人（生成 config.toml）之后才启动；没有就只跑网页版。
if [ -f /data/.cc-connect/config.toml ]; then
  /opt/workpartner/bin/cc-connect --config /data/.cc-connect/config.toml &
  service_pids+=("$!")
fi
# 网关启用预览时先写入个人 relay key；独立启动且没有 key 时只运行对话入口。
if [ -f /data/.zp-preview-relay-key ]; then
  node /opt/workpartner/preview/workspace.mjs "$PARTNER_GATEWAY_ORIGIN" &
  service_pids+=("$!")
fi
# Restart when a service exits, ignoring adopted detached exec processes.
wait -n "${service_pids[@]}"
exit $?

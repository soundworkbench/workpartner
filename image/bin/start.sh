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
# 个人设置只在第一次写；公司技能每次启动同步（覆盖同名，保留本人另装的）。
[ -f /data/.claude/settings.json ] || cp /opt/workpartner/home/claude-settings.json /data/.claude/settings.json
cp -R /opt/workpartner/skills/. /data/.claude/skills/
# Codex 直接链到镜像里的同一份公司技能；镜像里删掉的技能，留下的断链一并清掉。本人同名目录优先，不覆盖。
for d in /opt/workpartner/skills/*/; do ln -sfnT "${d%/}" "$CODEX_HOME/skills/$(basename "$d")" 2>/dev/null; done
find "$CODEX_HOME/skills" -maxdepth 1 -xtype l -delete
if [ ! -f "$CODEX_HOME/config.toml" ]; then
  python3 -I - /opt/workpartner/home/codex-config.toml "$CODEX_HOME/config.toml" <<'PYTHON'
import json, os, sys
from pathlib import Path
# Quote as a TOML basic string; endpoint characters must not become template syntax.
url = json.dumps(os.environ['MODEL_BASE_URL'], ensure_ascii=False)[1:-1]
Path(sys.argv[2]).write_text(Path(sys.argv[1]).read_text().replace('__MODEL_BASE_URL__', url))
PYTHON
fi
# 引擎启动前校正早期模型名前缀，并为支持的提供方补齐原生网页搜索开关。
python3 -I /opt/workpartner/bin/wp-normalize-codex-model.py "$CODEX_HOME/config.toml" || echo "警告：未更新 Codex 配置，继续启动" >&2
# 首次写整份说明；原样旧模板整份升级；个人说明只同步统一块，已有 AGENTS.md 不动。
if ! instructions_error=$(python3 -I /opt/workpartner/bin/wp-sync-instructions.py \
  /opt/workpartner/home/CLAUDE.md /data/work "${PARTNER_USER_NAME:-同事}" 2>&1); then
  printf '警告：%s；继续启动，下次启动重试。\n' "$instructions_error" >&2
fi

cd /data/work
trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM INT
AIONUI_PORT=${AIONUI_PORT:-25808}
/opt/aionui/aionui-web start --static-dir /opt/aionui/static-wp --remote --port "$AIONUI_PORT" --no-open --data-dir /data/aionui-data &

# 每次启动校正助手（只开 ChatGPT 和 Claude，ChatGPT 排第一；没有 Claude 权限就只开 ChatGPT），第一次还写中文和默认助手。
# 失败不影响启动，下次启动重试。
for _ in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$AIONUI_PORT/api/assistants" && break; sleep 1; done
python3 -I /opt/workpartner/bin/wp-seed.py "http://127.0.0.1:$AIONUI_PORT"

# 消息桥：本人扫码建好机器人（生成 config.toml）之后才启动；没有就只跑网页版。
if [ -f /data/.cc-connect/config.toml ]; then
  /opt/workpartner/bin/cc-connect --config /data/.cc-connect/config.toml &
fi
# 任一进程退出就退出整个容器，由 Docker 的重启策略整体拉起。
wait -n
exit $?

# 工作伙伴新版每人容器：Claude Code 引擎（Codex 可选）+ AionUi 网页版（换品牌、精简）+ JConnect 消息桥。
# 程序都在镜像里，每人只有 /data。构建目录由 build.sh 组装（AionUi 包、JConnect、OfficeCLI、Codex 不进仓库）。
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
ARG IMAGE_SKILLS=

ARG CLAUDE_CODE_VERSION=2.1.319
ARG PLAYWRIGHT_VERSION=1.61.1
USER root

# Keep service paths on the data volume; refuse to discard existing image content.
RUN rmdir /srv && ln -s /data/srv /srv
RUN install -d -o 1001 -g 1001 -m 755 /run/mysqld

# 中文字体：镜像已有 Noto Sans/Serif CJK；补文泉驿微米黑/正黑，以及 Office 常用西文字体的等宽替代。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 curl git ripgrep ffmpeg librsvg2-bin openssh-client iproute2 util-linux fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 node-js-yaml python3-yaml \
 && rm -rf /var/lib/apt/lists/*
RUN if ! getent passwd 1001 >/dev/null; then \
      groupadd -f -g 1001 partner && useradd -u 1001 -g 1001 -M -d /data -s /bin/sh partner; fi \
 && npm install -g --no-audit --no-fund pnpm@11.28.5 \
 && npm cache clean --force
# Reuse matching identity CLIs from a company base; plain Node installs the same versions.
RUN if ! node -e 'for (const [name, version] of [["@larksuite/cli", "1.0.99"], ["@lark-project/meegle", "1.0.27"]]) if (require("/opt/partner-clis/lib/node_modules/" + name + "/package.json").version !== version) process.exit(1)' 2>/dev/null; then \
      npm install -g --prefix /opt/partner-clis --no-audit --no-fund @larksuite/cli@1.0.99 @lark-project/meegle@1.0.27 && npm cache clean --force; fi
COPY image/feishu/cli.mjs /opt/workpartner/feishu/cli.mjs
COPY image/feishu/lark-cli image/feishu/meegle /usr/local/bin/
RUN chmod 755 /usr/local/bin/lark-cli /usr/local/bin/meegle \
 && if [ /opt/workpartner != /opt/workpartner ]; then ln -sT /opt/workpartner /opt/workpartner; fi
ENV WORKPARTNER_IDENTITY_CONFIG=/data/.wp-feishu-cli.json LARKSUITE_CLI_STRICT_MODE=user
COPY image/fonts.conf /etc/fonts/conf.d/60-workpartner-cjk.conf
RUN chmod 644 /etc/fonts/conf.d/60-workpartner-cjk.conf && fc-cache -f
# 文档与排查工具：LibreOffice 只装无界面组件（Word/Excel/PPT 转 PDF），poppler-utils（pdftoppm 等），procps（ps），pip。
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps poppler-utils python3-pip \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
 && rm -rf /var/lib/apt/lists/*

# Claude Code 与 Playwright Chromium，版本固定；Claude Code 不自动升级。
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY pkg/claude /opt/claude/bin/claude
RUN npm install -g --prefix /opt/playwright --no-audit --no-fund playwright@${PLAYWRIGHT_VERSION} \
 && /opt/playwright/bin/playwright install --with-deps chromium \
 && npm cache clean --force && rm -rf /var/lib/apt/lists/* /root/.npm

# AionUi 网页版独立包；换品牌、精简后的前端生成到 static-wp，原版 static 保留以便对照。
COPY pkg/aionui-web /opt/aionui
COPY brand /tmp/brand
COPY image/rebrand /tmp/rebrand
COPY image/skills-zh.json /tmp/skills-zh.json
COPY streaming/smooth-text.mjs /tmp/smooth-text.mjs
RUN python3 -I /tmp/rebrand/rebrand.py /opt/aionui/static /opt/aionui/static-wp /tmp/brand /tmp/rebrand/overlay /tmp/smooth-text.mjs /tmp/brand/skin.json \
 && rm -rf /tmp/brand /tmp/rebrand /tmp/smooth-text.mjs /tmp/skills-zh.json

# JConnect（cc-connect）、OfficeCLI、Codex CLI 与入口脚本；OfficeCLI 的技能在构建时生成，启动时同步给 Claude Code、链给 Codex；python 指向 python3。
COPY pkg/cc-connect pkg/officecli pkg/codex pkg/codex-code-mode-host image/bin/ /opt/workpartner/bin/
COPY preview/relay.mjs preview/policy.mjs preview/transport.mjs preview/workspace.mjs /opt/workpartner/preview/
COPY image/home/ /opt/workpartner/home/
COPY image/agent-baseline/ /opt/workpartner/agent-baseline/
COPY organization/ /opt/workpartner/organization/
COPY image/skills-zh.json /opt/workpartner/skills-zh.json
COPY image/skill-descriptions.json /opt/workpartner/skill-descriptions.json
# AionUi 自带的 Codex 0.144.6 不认识 gpt-6.1-sol（元数据缺失警告、模型标签错成 GPT-5.6-Sol），换成同一份 0.167.0。
RUN for d in /opt/aionui/bundled-aioncore/linux-x64/managed-resources/cli/codex/*/linux-x64/vendor/*/bin; do \
      cp -f /opt/workpartner/bin/codex /opt/workpartner/bin/codex-code-mode-host "$d"/; done
# AionCore 0.1.58 retains aggregatedOutput but drops completed webSearch fields.
# Keep the native CLI next to its adapter, including each managed app-server path.
RUN for d in /opt/workpartner/bin /opt/aionui/bundled-aioncore/linux-x64/managed-resources/cli/codex/*/linux-x64/vendor/*/bin; do \
      mv "$d/codex" "$d/codex.real"; \
      cp /opt/workpartner/bin/wp-codex.py "$d/codex"; chmod 755 "$d/codex"; done
COPY image/skills/ /opt/workpartner/extra-skills/
RUN mkdir -p /tmp/skel/.claude/skills \
 && for s in ${IMAGE_SKILLS}; do \
      if [ "$s" = officecli ]; then HOME=/tmp/skel /opt/workpartner/bin/officecli skills claude; \
      else HOME=/tmp/skel /opt/workpartner/bin/officecli skills install "$s" claude; fi; done \
 && mv /tmp/skel/.claude/skills /opt/workpartner/skills && rm -rf /tmp/skel \
 && if [ -f /opt/workpartner/organization/official-skills.tar.gz ]; then python3 -I /opt/workpartner/bin/wp-feishu-skills.py /opt/workpartner/organization/official-skills.tar.gz /opt/workpartner/skills; fi \
 && cp -R /opt/workpartner/extra-skills/. /opt/workpartner/skills/ \
 && python3 -I /opt/workpartner/bin/wp-compact-skills.py /opt/workpartner/skills /opt/workpartner/skill-descriptions.json \
 && node /opt/workpartner/bin/wp-skill-catalog.mjs /opt/workpartner/skills /opt/workpartner/skills-zh.json /opt/workpartner/home/CLAUDE.md \
 && chmod 755 /opt/workpartner/bin/wp-agent /opt/workpartner/bin/wp-skill /opt/workpartner/bin/wp-market /opt/workpartner/bin/wp-data /opt/workpartner/bin/chromium \
 && chmod -R a+rX /opt/workpartner /opt/aionui \
 && ln -sf python3 /usr/bin/python

# 原镜像的 旧版后端 钩子（NODE_OPTIONS）与 Claude Code 无关，清掉。
ENV PATH=/opt/workpartner/bin:/opt/claude/bin:/opt/playwright/bin:/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_PATH=/opt/playwright/lib/node_modules \
    NODE_OPTIONS= \
    DISABLE_AUTOUPDATER=1 \
    WORKPARTNER_ORG_DIR=/opt/workpartner/organization/selected \
    HOME=/data \
    PIP_BREAK_SYSTEM_PACKAGES=1
# Login shells reset PATH in /etc/profile, and Codex runs commands through one; keep the image PATH there.
RUN printf 'PATH=%s\nexport PATH\n' "$PATH" > /etc/profile.d/workpartner-path.sh
USER 1001:1001
# Verify the runtime user can load system trust roots before accepting the image.
RUN test -s /etc/ssl/certs/ca-certificates.crt \
 && python3 -I -c 'import ssl; assert ssl.create_default_context().cert_store_stats()["x509_ca"] > 0'
# Verify the document and browser tools as the runtime user, from a login shell, through a real Word -> PDF -> PNG run.
RUN cd /tmp && HOME=/tmp bash -lc 'set -e; \
      officecli --version; chromium --version; pdftoppm -v 2>&1 | head -1; soffice --headless --version; ps --version; pip --version; \
      officecli create check.docx >/dev/null; officecli add check.docx /body --type paragraph --prop text=check >/dev/null; officecli close check.docx >/dev/null; \
      soffice --headless --convert-to pdf check.docx >/dev/null; pdftoppm -png -r 30 -singlefile check.pdf check; test -s check.png' \
 && rm -rf /tmp/check.* /tmp/.config /tmp/.cache /tmp/.local
WORKDIR /data
ENTRYPOINT ["/opt/workpartner/bin/start.sh"]

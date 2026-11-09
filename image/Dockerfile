# 工作伙伴新版每人容器：Claude Code 引擎（Codex 可选）+ AionUi 网页版（换品牌、精简）+ JConnect 消息桥。
# 程序都在镜像里，每人只有 /data。构建目录由 build.sh 组装（AionUi 包、JConnect、OfficeCLI、Codex 不进仓库）。
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
ARG IMAGE_SKILLS=

ARG CLAUDE_CODE_VERSION=2.1.319
ARG PLAYWRIGHT_VERSION=1.61.1
USER root

# 中文字体：镜像已有 Noto Sans/Serif CJK；补文泉驿微米黑/正黑，以及 Office 常用西文字体的等宽替代。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 curl fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 node-js-yaml python3-yaml \
 && rm -rf /var/lib/apt/lists/*
COPY image/fonts.conf /etc/fonts/conf.d/60-workpartner-cjk.conf
RUN chmod 644 /etc/fonts/conf.d/60-workpartner-cjk.conf && fc-cache -f

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
COPY image/home/ /opt/workpartner/home/
COPY organization/ /opt/workpartner/organization/
COPY image/skills-zh.json /opt/workpartner/skills-zh.json
# AionUi 自带的 Codex 0.144.6 不认识 gpt-6.1-sol（元数据缺失警告、模型标签错成 GPT-5.6-Sol），换成同一份 0.167.0。
RUN for d in /opt/aionui/bundled-aioncore/linux-x64/managed-resources/cli/codex/*/linux-x64/vendor/*/bin; do \
      cp -f /opt/workpartner/bin/codex /opt/workpartner/bin/codex-code-mode-host "$d"/; done
# AionCore 0.1.58 retains aggregatedOutput but drops completed webSearch fields.
# Keep the native CLI next to its adapter, including each managed app-server path.
RUN for d in /opt/workpartner/bin /opt/aionui/bundled-aioncore/linux-x64/managed-resources/cli/codex/*/linux-x64/vendor/*/bin; do \
      mv "$d/codex" "$d/codex.real"; \
      cp /opt/workpartner/bin/wp-codex.py "$d/codex"; chmod 755 "$d/codex"; done
RUN mkdir -p /tmp/skel/.claude/skills \
 && for s in ${IMAGE_SKILLS}; do \
      if [ "$s" = officecli ]; then HOME=/tmp/skel /opt/workpartner/bin/officecli skills claude; \
      else HOME=/tmp/skel /opt/workpartner/bin/officecli skills install "$s" claude; fi; done \
 && mv /tmp/skel/.claude/skills /opt/workpartner/skills && rm -rf /tmp/skel \
 && node /opt/workpartner/bin/wp-skill-catalog.mjs /opt/workpartner/skills /opt/workpartner/skills-zh.json /opt/workpartner/home/CLAUDE.md \
 && chmod 755 /opt/workpartner/bin/wp-skill \
 && chmod -R a+rX /opt/workpartner \
 && ln -sf python3 /usr/bin/python

# 原镜像的 旧版后端 钩子（NODE_OPTIONS）与 Claude Code 无关，清掉。
ENV PATH=/opt/workpartner/bin:/opt/claude/bin:/opt/playwright/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_PATH=/opt/playwright/lib/node_modules \
    NODE_OPTIONS= \
    DISABLE_AUTOUPDATER=1 \
    WORKPARTNER_ORG_DIR=/opt/workpartner/organization/selected \
    HOME=/data
USER 1001:1001
WORKDIR /data
ENTRYPOINT ["/opt/workpartner/bin/start.sh"]

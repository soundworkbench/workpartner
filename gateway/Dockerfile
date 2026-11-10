FROM node:24-bookworm-slim
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY gateway/ ./gateway/
COPY feishu/ /app/feishu/
COPY preview/ /app/preview/
COPY org/default/ /app/org/default/

WORKDIR /app/gateway
CMD ["node", "gateway.mjs"]

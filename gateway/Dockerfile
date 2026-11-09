FROM node:24-bookworm-slim
WORKDIR /app/gateway
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY gateway/ ./
COPY org/default/ /app/org/default/

CMD ["node", "gateway.mjs"]

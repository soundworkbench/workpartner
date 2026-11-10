ARG GATEWAY_BASE
FROM ${GATEWAY_BASE}
COPY tools/k8s/e2e/ /app/tools/k8s/e2e/
WORKDIR /app
CMD ["node", "/app/tools/k8s/e2e/gateway.mjs"]

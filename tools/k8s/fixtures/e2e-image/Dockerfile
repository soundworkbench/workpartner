FROM node:24-bookworm-slim AS workspace
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 workspace && useradd --uid 1001 --gid 1001 --create-home workspace
WORKDIR /opt/e2e
COPY preview/ /opt/preview/
COPY image/bin/wp-init-hooks.sh /opt/e2e/wp-init-hooks.sh
COPY tools/k8s/fixtures/e2e-image/ /opt/e2e/
RUN chmod +x /opt/e2e/start.sh /opt/e2e/aionui-web \
    && ln -s /opt/e2e/aionui-web /usr/local/bin/aionui-web \
    && mkdir /data && chown 1001:1001 /data
USER 1001:1001
ENTRYPOINT ["/opt/e2e/start.sh"]

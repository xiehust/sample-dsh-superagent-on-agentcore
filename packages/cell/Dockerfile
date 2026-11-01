# dshsa-host image (arm64). Build context: the repository root (see infra/lib/constructs/host.ts).
FROM --platform=linux/arm64 node:24-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/sources packages/sources
COPY packages/assess packages/assess
COPY packages/cell packages/cell
RUN pnpm install --frozen-lockfile --filter @dshsa/cell... && pnpm --filter @dshsa/cell build

FROM --platform=linux/arm64 node:24-slim
ARG LITESTREAM_VERSION=0.3.13
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-arm64.tar.gz" | tar -xz -C /usr/local/bin litestream && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* && \
    useradd --uid 10001 --create-home host && mkdir -p /data && chown host /data
WORKDIR /app
COPY --from=build /src/packages/cell/dist ./dist
COPY --from=build /src/packages/cell/prompts ./prompts
COPY --from=build /src/packages/cell/skills ./skills
ENV NODE_ENV=production DSHSA_ASSETS=/app DATA_DIR=/data
USER host
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/host.mjs"]

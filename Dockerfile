# The public demo image: Thaliyola and its own Postgres 16 (with pgvector) in one container, wiped and re-seeded every
# 12 hours (DEMO_MODE). This is what Tricknowtech (and any host that builds the root Dockerfile) runs for the demo.
# A real installation uses apps/server/Dockerfile with its own database: see docs/install.md.
#
#   docker build -t thaliyola-demo . && docker run -p 3000:3000 -e PUBLIC_URL=http://localhost:3000 thaliyola-demo

FROM node:24.22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY apps/web apps/web
COPY deploy/prune-runtime.sh deploy/prune-runtime.sh
COPY CHANGELOG.md CHANGELOG.md
ARG BUILD_SHA=""
RUN pnpm --filter @thaliyola/web build \
 && pnpm --filter @thaliyola/server build \
 && pnpm --filter @thaliyola/server deploy --prod /out \
 && deploy/prune-runtime.sh /out/node_modules

FROM node:24.22-bookworm-slim AS node

FROM pgvector/pgvector:0.8.0-pg16
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN useradd --system --create-home --home-dir /app app && mkdir -p /data/assets /data/models && chown -R app /data
WORKDIR /app
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json package.json
COPY --from=build /repo/apps/server/dist dist
COPY --from=build /repo/apps/server/migrations migrations
COPY --from=build /repo/CHANGELOG.md CHANGELOG.md
COPY --from=build /repo/apps/web/dist web
COPY --from=build /repo/apps/web/dist-viewer viewer
COPY deploy/demo/entrypoint.sh /usr/local/bin/thaliyola-demo
RUN chmod 755 /usr/local/bin/thaliyola-demo

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    DATABASE_URL=postgres://thaliyola@localhost/thaliyola?host=/var/run/postgresql \
    AUTH_MODE=local \
    DEMO_MODE=true \
    DEMO_RESET_HOURS=12 \
    EMBEDDINGS=local \
    EMBEDDING_CACHE_DIR=/data/models \
    ASSET_DIR=/data/assets \
    CONNECTIONS=off \
    SOURCES=off \
    VULN_SCAN=off \
    ADVISORY_FEED=off \
    MAIL_TRANSPORT=off \
    TRUST_PROXY=true
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/thaliyola-demo"]

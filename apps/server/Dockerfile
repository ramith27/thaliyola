# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY apps/web apps/web
COPY deploy/prune-runtime.sh deploy/prune-runtime.sh
RUN pnpm --filter @thaliyola/web build \
 && pnpm --filter @thaliyola/server build \
 && pnpm --filter @thaliyola/server deploy --prod /out \
 && deploy/prune-runtime.sh /out/node_modules

FROM node:22-slim
ENV NODE_ENV=production
ENV WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json package.json
COPY --from=build /repo/apps/server/dist dist
COPY --from=build /repo/apps/server/migrations migrations
COPY --from=build /repo/apps/web/dist web
COPY --from=build /repo/apps/web/dist-viewer viewer
RUN mkdir -p /data/assets /data/models && chown node:node /data/assets /data/models
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

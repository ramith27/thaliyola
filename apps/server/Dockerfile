# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:24.22-alpine AS build
# bash for deploy/prune-runtime.sh
RUN apk add --no-cache bash && corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Socket supply-chain scan of the installed tree, as the other Interest Media
# images do. CI passes the token as a build arg (KANIKO_BUILD_ARGS); a build
# without one, such as `docker compose build`, skips the scan. It is declared
# in this stage only, so it never reaches the runtime image.
ARG SOCKET_CLI_API_TOKEN
RUN if [ -n "$SOCKET_CLI_API_TOKEN" ]; then \
      npm install -g socket && socket ci; \
    else \
      echo "SOCKET_CLI_API_TOKEN not set, skipping socket ci"; \
    fi
COPY apps/server apps/server
COPY apps/web apps/web
# The commit this image is built from, for /healthz, /api/version and Help › About (dist/build-info.json). There is no
# .git in the build context, so CI passes it: --build-arg BUILD_SHA=$CI_COMMIT_SHA (GitLab, KANIKO_BUILD_ARGS) or
# --build-arg BUILD_SHA=$GITHUB_SHA. Without it the commit is reported as null.
ARG BUILD_SHA=""
ARG CI_COMMIT_SHA=""
COPY deploy/prune-runtime.sh deploy/prune-runtime.sh
COPY CHANGELOG.md CHANGELOG.md
RUN pnpm --filter @thaliyola/web build \
 && pnpm --filter @thaliyola/server build \
 && pnpm --filter @thaliyola/server deploy --prod /out \
 && deploy/prune-runtime.sh /out/node_modules

FROM node:24.22-alpine
ENV NODE_ENV=production
ENV WEB_DIST=/app/web
# Trust Amazon RDS certificates, so DATABASE_URL=...?sslmode=verify-full works against RDS without mounting a CA file
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/rds/global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/rds/global-bundle.pem
WORKDIR /app
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json package.json
COPY --from=build /repo/apps/server/dist dist
COPY --from=build /repo/apps/server/migrations migrations
# Release notes: a running version with no release yet is drafted from its CHANGELOG.md section.
COPY --from=build /repo/CHANGELOG.md CHANGELOG.md
COPY --from=build /repo/apps/web/dist web
COPY --from=build /repo/apps/web/dist-viewer viewer
RUN mkdir -p /data/assets /data/models && chown node:node /data/assets /data/models
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

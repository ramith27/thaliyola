#!/usr/bin/env bash
# Native install of Cairn on Debian/Ubuntu: Node 22 + Postgres 16 (pgvector) + systemd.
# Run as root from a checkout of the repo:   sudo deploy/native/install.sh
# Re-run to upgrade: it rebuilds, redeploys to /opt/cairn and restarts the service.
# Existing config in /etc/cairn/cairn.env and the database are kept.
#
# Optional environment:
#   DB_NAME (default cairn)   DB_USER (default cairn)
#   ADMIN_EMAIL               email granted admin rights on first install
#   PORT (default 8080)       HOST (default 127.0.0.1)
set -euo pipefail

DB_NAME="${DB_NAME:-cairn}"
DB_USER="${DB_USER:-cairn}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
APP_DIR=/opt/cairn
ENV_FILE=/etc/cairn/cairn.env
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '\n==> %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ && "$DB_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "DB_NAME/DB_USER must be lowercase identifiers" >&2; exit 1; }

log "System packages"
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! dpkg -s postgresql-16-pgvector >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq postgresql-16 postgresql-16-pgvector >/dev/null
fi
systemctl enable --now postgresql >/dev/null
corepack enable >/dev/null 2>&1 || npm install -g pnpm@9 >/dev/null

log "Service user"
id cairn >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin cairn

log "Database ($DB_NAME, owner $DB_USER)"
psql_su() { su postgres -c "psql -v ON_ERROR_STOP=1 -qtA $*"; }
NEW_PASSWORD=""
if [ -z "$(psql_su "-c \"SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'\"")" ]; then
  NEW_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  psql_su "-c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$NEW_PASSWORD'\""
fi
if [ -z "$(psql_su "-c \"SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'\"")" ]; then
  psql_su "-c \"CREATE DATABASE $DB_NAME OWNER $DB_USER\""
fi
# pgvector needs a superuser to install; the app's migrations then find it present.
psql_su "-d $DB_NAME -c \"CREATE EXTENSION IF NOT EXISTS vector\""

log "Asset storage (/var/lib/cairn/assets)"
install -d -m 750 -o cairn -g cairn /var/lib/cairn /var/lib/cairn/assets

log "Configuration ($ENV_FILE)"
install -d -m 750 -o root -g cairn /etc/cairn
if [ ! -f "$ENV_FILE" ]; then
  [ -n "$NEW_PASSWORD" ] || { echo "role $DB_USER exists but $ENV_FILE is missing; set its password and create the file" >&2; exit 1; }
  DEV_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
  (umask 077 && : > "$ENV_FILE")
  cat > "$ENV_FILE" <<CONF
# Cairn configuration. Restart after editing: systemctl restart cairn
PORT=$PORT
HOST=$HOST
DATABASE_URL=postgres://$DB_USER:$NEW_PASSWORD@localhost:5432/$DB_NAME
WEB_DIST=$APP_DIR/web
ASSET_DIR=/var/lib/cairn/assets

# Start in dev mode (static bearer tokens) until Cloudflare Access is set up.
# Never expose dev mode beyond this machine.
AUTH_MODE=dev
DEV_TOKENS=$DEV_TOKEN=${ADMIN_EMAIL:-admin@localhost}
ADMIN_EMAILS=${ADMIN_EMAIL:-admin@localhost}

# Production: AUTH_MODE=cloudflare plus
# CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
# CF_ACCESS_AUD=<Access application AUD tag>
CONF
  chown root:cairn "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  CREATED_TOKEN="$DEV_TOKEN"
fi

grep -q '^ASSET_DIR=' "$ENV_FILE" || echo "ASSET_DIR=/var/lib/cairn/assets" >> "$ENV_FILE"

log "Build"
cd "$REPO"
pnpm install --frozen-lockfile
pnpm --filter @cairn/web build
pnpm --filter @cairn/server build
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
pnpm --filter @cairn/server deploy --prod "$STAGE/app" >/dev/null

log "Deploy to $APP_DIR"
rm -rf "$APP_DIR.new"
mkdir "$APP_DIR.new"
cp -a "$STAGE/app/node_modules" "$STAGE/app/package.json" "$APP_DIR.new/"
cp -a apps/server/dist apps/server/migrations "$APP_DIR.new/"
cp -a apps/web/dist "$APP_DIR.new/web"
chown -R root:root "$APP_DIR.new"
chmod -R u=rwX,go=rX "$APP_DIR.new"  # readable by the service user, writable only by root
rm -rf "$APP_DIR.old"
if [ -e "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$APP_DIR.new" "$APP_DIR"

log "systemd"
install -m 644 deploy/native/cairn.service /etc/systemd/system/cairn.service
systemctl daemon-reload
systemctl enable cairn >/dev/null
systemctl restart cairn

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    log "Cairn is running on http://$HOST:$PORT"
    [ -n "${CREATED_TOKEN:-}" ] && echo "Dev token (also in $ENV_FILE): $CREATED_TOKEN"
    rm -rf "$APP_DIR.old"
    exit 0
  fi
  sleep 1
done
echo "Cairn did not become healthy; see: journalctl -u cairn -n 50" >&2
exit 1

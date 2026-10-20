#!/usr/bin/env bash
# Native install of Thaliyola on Debian/Ubuntu: Node 22 + Postgres 16 (pgvector) + systemd.
# Run as root from a checkout of the repo:   sudo deploy/native/install.sh
# Re-run to upgrade: it rebuilds, redeploys to /opt/thaliyola and restarts the service.
# Existing config in /etc/thaliyola/thaliyola.env and the database are kept.
#
# Optional environment:
#   DB_NAME (default thaliyola)   DB_USER (default thaliyola)
#   ADMIN_EMAIL               email granted admin rights on first install
#   PORT (default 8080)       HOST (default 127.0.0.1)
set -euo pipefail

DB_NAME="${DB_NAME:-thaliyola}"
DB_USER="${DB_USER:-thaliyola}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
APP_DIR=/opt/thaliyola
ENV_FILE=/etc/thaliyola/thaliyola.env
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
id thaliyola >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin thaliyola

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

log "Data directories (/var/lib/thaliyola)"
install -d -m 750 -o thaliyola -g thaliyola /var/lib/thaliyola /var/lib/thaliyola/assets /var/lib/thaliyola/models

log "Configuration ($ENV_FILE)"
install -d -m 750 -o root -g thaliyola /etc/thaliyola
if [ ! -f "$ENV_FILE" ]; then
  [ -n "$NEW_PASSWORD" ] || { echo "role $DB_USER exists but $ENV_FILE is missing; set its password and create the file" >&2; exit 1; }
  (umask 077 && : > "$ENV_FILE")
  cat > "$ENV_FILE" <<CONF
# Thaliyola configuration. Restart after editing: systemctl restart thaliyola
PORT=$PORT
HOST=$HOST
DATABASE_URL=postgres://$DB_USER:$NEW_PASSWORD@localhost:5432/$DB_NAME
WEB_DIST=$APP_DIR/web
ASSET_DIR=/var/lib/thaliyola/assets

# Semantic search: a small embedding model (~35 MB) is downloaded on first start.
# Set EMBEDDINGS=off on machines without internet access (keyword search only).
EMBEDDINGS=local
EMBEDDING_CACHE_DIR=/var/lib/thaliyola/models

# Sign-in: local = built-in accounts (manage with thaliyola-admin and the Users page).
# For Cloudflare Access instead:
#   AUTH_MODE=cloudflare
#   CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
#   CF_ACCESS_AUD=<Access application AUD tag>
AUTH_MODE=local
# Public https URL (reverse proxy or tunnel); enables OAuth so claude.ai connectors can sign in.
# PUBLIC_URL=https://thaliyola.example.com
CONF
  chown root:thaliyola "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

grep -q '^ASSET_DIR=' "$ENV_FILE" || echo "ASSET_DIR=/var/lib/thaliyola/assets" >> "$ENV_FILE"
grep -q '^EMBEDDING_CACHE_DIR=' "$ENV_FILE" || printf 'EMBEDDINGS=local\nEMBEDDING_CACHE_DIR=/var/lib/thaliyola/models\n' >> "$ENV_FILE"

log "Build"
cd "$REPO"
pnpm install --frozen-lockfile
pnpm --filter @thaliyola/web build
pnpm --filter @thaliyola/server build
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
pnpm --filter @thaliyola/server deploy --prod "$STAGE/app" >/dev/null
deploy/prune-runtime.sh "$STAGE/app/node_modules"

log "Deploy to $APP_DIR"
rm -rf "$APP_DIR.new"
mkdir "$APP_DIR.new"
cp -a "$STAGE/app/node_modules" "$STAGE/app/package.json" "$APP_DIR.new/"
cp -a apps/server/dist apps/server/migrations "$APP_DIR.new/"
cp -a apps/web/dist "$APP_DIR.new/web"
if [ -d apps/web/dist-viewer ]; then cp -a apps/web/dist-viewer "$APP_DIR.new/viewer"; fi
chown -R root:root "$APP_DIR.new"
chmod -R u=rwX,go=rX "$APP_DIR.new"  # readable by the service user, writable only by root
rm -rf "$APP_DIR.old"
if [ -e "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$APP_DIR.new" "$APP_DIR"

log "thaliyola-admin command"
cat > /usr/local/bin/thaliyola-admin <<'ADMIN'
#!/usr/bin/env bash
# Thaliyola account administration, e.g.: thaliyola-admin create-user --email you@example.com --admin
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo thaliyola-admin ...)" >&2; exit 1; }
set -a; . /etc/thaliyola/thaliyola.env; set +a
exec runuser -u thaliyola -- /usr/bin/node /opt/thaliyola/dist/scripts/admin.js "$@"
ADMIN
chmod 755 /usr/local/bin/thaliyola-admin

log "Backups (daily to /var/backups/thaliyola)"
install -m 755 deploy/native/backup.sh /usr/local/bin/thaliyola-backup
install -m 755 deploy/native/restore.sh /usr/local/bin/thaliyola-restore
install -m 644 deploy/native/thaliyola-backup.service deploy/native/thaliyola-backup.timer /etc/systemd/system/

log "systemd"
install -m 644 deploy/native/thaliyola.service /etc/systemd/system/thaliyola.service
systemctl daemon-reload
systemctl enable thaliyola >/dev/null
systemctl enable --now thaliyola-backup.timer >/dev/null
systemctl restart thaliyola

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    log "Thaliyola is running on http://$HOST:$PORT"
    if grep -q '^AUTH_MODE=local' "$ENV_FILE" && [ -z "$(psql_su "-d $DB_NAME -c \"SELECT 1 FROM users WHERE subject LIKE 'local:%' LIMIT 1\"")" ]; then
      if [ -n "${ADMIN_EMAIL:-}" ]; then
        log "First admin"
        /usr/local/bin/thaliyola-admin create-user --email "$ADMIN_EMAIL" --admin
      else
        echo "No accounts yet. Create the first admin with:"
        echo "  sudo thaliyola-admin create-user --email you@example.com --admin"
      fi
    fi
    rm -rf "$APP_DIR.old"
    exit 0
  fi
  sleep 1
done
echo "Thaliyola did not become healthy; see: journalctl -u thaliyola -n 50" >&2
exit 1

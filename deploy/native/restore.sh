#!/usr/bin/env bash
# Restores a Thaliyola backup made by thaliyola-backup. Replaces the current database and files.
# Usage: thaliyola-restore <thaliyola-…dump> [--yes]
#        TARGET_DB=other_db thaliyola-restore <dump> --yes   (restore into another database, e.g. to test a backup)
set -euo pipefail
DUMP="${1:?usage: thaliyola-restore <thaliyola-…dump> [--yes]}"
ASSETS="${DUMP%.dump}.assets.tar.gz"
ENV_FILE=/etc/thaliyola/thaliyola.env
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
live_db="$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
db_user="$(node -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).username))')"
target="${TARGET_DB:-$live_db}"
[[ "$target" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "bad database name" >&2; exit 1; }

live=false
[ "$target" = "$live_db" ] && live=true
if [ "${2:-}" != "--yes" ]; then
  if $live; then echo "This replaces database '$target' and the uploaded files with $DUMP."; else echo "This replaces database '$target' with $DUMP."; fi
  read -r -p "Type the database name to continue: " answer
  [ "$answer" = "$target" ] || { echo "aborted"; exit 1; }
fi

$live && systemctl stop thaliyola
su postgres -c "psql -v ON_ERROR_STOP=1 -q -c 'DROP DATABASE IF EXISTS $target' -c 'CREATE DATABASE $target OWNER $db_user'"
su postgres -c "psql -v ON_ERROR_STOP=1 -q -d $target -c 'CREATE EXTENSION IF NOT EXISTS vector'"
# Restore as the app's own role; extension entries need a superuser and were created above.
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
pg_restore --list "$DUMP" | grep -v -E ' EXTENSION | COMMENT - EXTENSION ' > "$list"
target_url="$(TARGET="$target" node -e 'const u = new URL(process.env.DATABASE_URL); u.pathname = "/" + process.env.TARGET; console.log(u.href)')"
pg_restore --no-owner --no-acl --exit-on-error --use-list="$list" --dbname="$target_url" "$DUMP"
if $live && [ -f "$ASSETS" ]; then
  dir="${ASSET_DIR:-/var/lib/thaliyola/assets}"
  rm -rf "$dir.restore" && mkdir -p "$dir.restore"
  tar -C "$dir.restore" -xzf "$ASSETS"
  rm -rf "$dir" && mv "$dir.restore/$(basename "$dir")" "$dir" && rm -rf "$dir.restore"
  chown -R thaliyola:thaliyola "$dir"
fi
$live && systemctl start thaliyola
echo "restored $DUMP into $target"

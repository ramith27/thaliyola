#!/usr/bin/env bash
# Backs up Cairn: database (pg_dump custom format) and uploaded files.
# Usage: cairn-backup [destination dir]   (default /var/backups/cairn; keeps the newest $KEEP, default 14)
set -euo pipefail
DEST="${1:-/var/backups/cairn}"
KEEP="${KEEP:-14}"
ENV_FILE=/etc/cairn/cairn.env
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$DEST"
umask 077
db_name="$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
su postgres -c "pg_dump --format=custom --no-owner --dbname=$db_name" > "$DEST/cairn-$stamp.dump"
if [ "${ASSET_STORE:-local}" = "s3" ]; then
  echo "wrote $DEST/cairn-$stamp.dump ($(du -h "$DEST/cairn-$stamp.dump" | cut -f1)); files live in S3 bucket ${S3_BUCKET:-?}: back that up with your provider's versioning or replication"
else
  tar -C "$(dirname "${ASSET_DIR:-/var/lib/cairn/assets}")" -czf "$DEST/cairn-$stamp.assets.tar.gz" "$(basename "${ASSET_DIR:-/var/lib/cairn/assets}")"
  echo "wrote $DEST/cairn-$stamp.dump ($(du -h "$DEST/cairn-$stamp.dump" | cut -f1)) and $DEST/cairn-$stamp.assets.tar.gz"
fi

# Retention: keep the newest $KEEP pairs.
ls -1t "$DEST"/cairn-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "${old%.dump}.assets.tar.gz"
done

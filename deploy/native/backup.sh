#!/usr/bin/env bash
# Backs up Thaliyola: database (pg_dump custom format) and uploaded files.
# Usage: thaliyola-backup [destination dir]   (default /var/backups/thaliyola; keeps the newest $KEEP, default 14)
# With BACKUP_S3_BUCKET (and BACKUP_S3_ENDPOINT, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY) in the env file, each backup is
# also copied off the machine (encrypted with BACKUP_ENCRYPTION_KEY when set). Every run is reported to
# Admin › System › Health.
set -euo pipefail
DEST="${1:-/var/backups/thaliyola}"
KEEP="${KEEP:-14}"
ENV_FILE=/etc/thaliyola/thaliyola.env
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
JS="${THALIYOLA_JS:-/opt/thaliyola/dist/scripts/backup.js}"
report() { node "$JS" report "$@" >/dev/null 2>&1 || true; }
trap 'report backup failed "thaliyola-backup failed at line $LINENO"' ERR

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$DEST"
umask 077
db_name="$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
su postgres -c "pg_dump --format=custom --no-owner --dbname=$db_name" > "$DEST/thaliyola-$stamp.dump"
if [ "${ASSET_STORE:-local}" = "s3" ]; then
  echo "wrote $DEST/thaliyola-$stamp.dump ($(du -h "$DEST/thaliyola-$stamp.dump" | cut -f1)); files live in S3 bucket ${S3_BUCKET:-?}: back that up with your provider's versioning or replication"
else
  tar -C "$(dirname "${ASSET_DIR:-/var/lib/thaliyola/assets}")" -czf "$DEST/thaliyola-$stamp.assets.tar.gz" "$(basename "${ASSET_DIR:-/var/lib/thaliyola/assets}")"
  echo "wrote $DEST/thaliyola-$stamp.dump ($(du -h "$DEST/thaliyola-$stamp.dump" | cut -f1)) and $DEST/thaliyola-$stamp.assets.tar.gz"
fi

bytes="$(stat -c %s "$DEST/thaliyola-$stamp.dump")"
JOB_DETAILS="{\"file\":\"$DEST/thaliyola-$stamp.dump\",\"bytes\":$bytes}" report backup ok

# Off-site copy (it reports itself as backup_offsite).
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  files=("$DEST/thaliyola-$stamp.dump")
  [ -f "$DEST/thaliyola-$stamp.assets.tar.gz" ] && files+=("$DEST/thaliyola-$stamp.assets.tar.gz")
  node "$JS" upload "${files[@]}"
fi

# Retention: keep the newest $KEEP pairs.
ls -1t "$DEST"/thaliyola-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "${old%.dump}.assets.tar.gz"
done

#!/usr/bin/env bash
# Proves the backups restore: takes the newest backup (the off-site copy when BACKUP_S3_BUCKET is set, else the newest
# in /var/backups/thaliyola), restores it into a scratch database, compares row counts of the key tables with the live
# database, and drops the copy. The result shows on Admin › System › Health; admins are told when it fails.
# Usage: thaliyola-restore-check   (monthly by thaliyola-restore-check.timer)
set -euo pipefail
ENV_FILE=/etc/thaliyola/thaliyola.env
CHECK_DB=thaliyola_restore_check
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
JS="${THALIYOLA_JS:-/opt/thaliyola/dist/scripts/backup.js}"
report() { node "$JS" report "$@" >/dev/null 2>&1 || true; }
work="$(mktemp -d)"
cleanup() { su postgres -c "psql -q -c 'DROP DATABASE IF EXISTS $CHECK_DB'" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap 'report restore_check failed "thaliyola-restore-check failed at line $LINENO"; cleanup' ERR
trap cleanup EXIT

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  dump="$(node "$JS" fetch-latest "$work")"; source="off-site copy"
else
  dump="$(ls -1t /var/backups/thaliyola/thaliyola-*.dump 2>/dev/null | head -1)"; source="local backup"
  [ -n "$dump" ] || { report restore_check failed "no backup to restore"; echo "no backup found" >&2; exit 1; }
fi
TARGET_DB="$CHECK_DB" /usr/local/bin/thaliyola-restore "$dump" --yes >/dev/null
if result="$(node "$JS" compare "$CHECK_DB")"; then
  JOB_DETAILS="$result" report restore_check ok "restored $(basename "$dump") from the $source"
  echo "restore check passed: $(basename "$dump") from the $source"
else
  JOB_DETAILS="$result" report restore_check failed "the restored copy's row counts don't match the live data"
  echo "restore check FAILED: $result" >&2
  exit 1
fi

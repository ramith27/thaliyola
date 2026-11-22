#!/bin/bash
# The demo container: starts its private Postgres (Unix socket only, no TCP), then Thaliyola in DEMO_MODE, which wipes and
# re-seeds the data on start and every DEMO_RESET_HOURS. Nothing here is kept: the data lives and dies with the container.
set -euo pipefail
export PGDATA=/var/lib/postgresql/data
PGBIN=/usr/lib/postgresql/16/bin
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown -R postgres:postgres /var/lib/postgresql
  su postgres -c "$PGBIN/initdb -D $PGDATA --encoding=UTF8 --locale=C.UTF-8 --auth=trust" >/dev/null
  cat >> "$PGDATA/postgresql.conf" <<CONF
listen_addresses = ''
shared_buffers = 96MB
max_connections = 40
fsync = off
synchronous_commit = off
CONF
fi
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/postgres.log -w start" >/dev/null
# The app's role owns its database and may recreate the vector extension when the demo resets (superuser: the
# database is private to this container and wiped every few hours).
su postgres -c "psql -qtAc \"SELECT 1 FROM pg_roles WHERE rolname = 'thaliyola'\"" | grep -q 1 \
  || su postgres -c "psql -qc \"CREATE ROLE thaliyola LOGIN SUPERUSER PASSWORD 'thaliyola'\""
su postgres -c "psql -qtAc \"SELECT 1 FROM pg_database WHERE datname = 'thaliyola'\"" | grep -q 1 \
  || su postgres -c "createdb -O thaliyola -E UTF8 -T template0 thaliyola"
su postgres -c "psql -q -d thaliyola -c 'CREATE EXTENSION IF NOT EXISTS vector'"
echo "[demo] postgres ready; starting Thaliyola"
exec setpriv --reuid=app --regid=app --init-groups /usr/local/bin/node /app/dist/index.js

# Installing and upgrading Thaliyola

Three ways to run it, then what every install needs: a UTF-8 Postgres 16 database with pgvector. The schema is created and upgraded by the server itself.

## Requirements

| | |
|---|---|
| Node | 22 |
| pnpm | 9 (building from source) |
| Postgres | 16 with [pgvector](https://github.com/pgvector/pgvector), **UTF-8 encoding** |
| Memory | about 1 GB for the server with search by meaning (`EMBEDDINGS=local` loads a 35 MB model) |
| Outbound network (optional) | `api.osv.dev`, `www.cisa.gov`, `services.nvd.nist.gov`, `api.github.com` for security; `huggingface.co` once for the search model |

## Docker

```sh
cp .env.example .env          # set POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec server node dist/scripts/admin.js create-user --email you@example.com --admin
```

The Postgres image creates a UTF-8 database, so nothing more is needed.

## Native (Debian or Ubuntu, systemd)

```sh
git clone https://github.com/ramith27/thaliyola && cd thaliyola
sudo ADMIN_EMAIL=you@example.com deploy/native/install.sh
```

The script installs Node 22 and Postgres 16 with pgvector, creates the `thaliyola` service user and a UTF-8 database, builds the server and web app into `/opt/thaliyola`, writes `/etc/thaliyola/thaliyola.env`, and starts the `thaliyola` service on `127.0.0.1:8080`, with daily backups. Put nginx in front with [`deploy/native/nginx-thaliyola.conf`](../deploy/native/nginx-thaliyola.conf) and set `PUBLIC_URL`.

| Variable for the script | Default | Meaning |
|---|---|---|
| `ADMIN_EMAIL` | none | Creates the first Administrator and prints its temporary password |
| `DB_NAME`, `DB_USER` | `thaliyola` | Database and role (use these to keep an existing database's names) |

**Upgrading:** `git pull`, then run the same command again (with the same `DB_NAME`/`DB_USER`). It keeps the configuration and the database, applies new migrations on start, and restarts the service. Check with `curl -s localhost:8080/healthz`: it reports the version and commit.

## Kubernetes

See [`deploy/k8s/README.md`](../deploy/k8s/README.md). Use a managed Postgres 16 with pgvector, created with UTF-8 encoding (the default on every managed service).

## The database must be UTF-8

Thaliyola normalises and redacts text with functions that only work in a UTF-8 database. A database created on a server whose default template is `SQL_ASCII` (some older images and hand-made clusters) works at first and then fails with *"Unicode normalization can only be performed if server encoding is UTF8"*. From 1.1.1 the server logs a warning at start when the database isn't UTF-8, and `install.sh` refuses to continue.

Check:

```sh
sudo -u postgres psql -tAc "SELECT datname, pg_encoding_to_char(encoding) FROM pg_database"
```

Creating one by hand:

```sql
CREATE ROLE thaliyola LOGIN PASSWORD '…';
CREATE DATABASE thaliyola OWNER thaliyola ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
\c thaliyola
CREATE EXTENSION vector;   -- needs a superuser; the migrations expect it present
```

### Converting an existing database

A dump and restore into a new UTF-8 database. Text written so far is plain ASCII or already UTF-8 bytes, so it carries over unchanged. Keep the old database until you're sure.

```sh
sudo systemctl stop thaliyola
sudo -u postgres pg_dump -Fc thaliyola_prod > /root/thaliyola_prod-before-utf8.dump

sudo -u postgres psql -c "ALTER DATABASE thaliyola_prod RENAME TO thaliyola_prod_sqlascii"
sudo -u postgres psql -c "CREATE DATABASE thaliyola_prod OWNER thaliyola_svc ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"
sudo -u postgres psql -d thaliyola_prod -c "CREATE EXTENSION vector"
# pg_restore reads from stdin, so the postgres user needn't be able to read /root
sudo -u postgres pg_restore --no-owner --role=thaliyola_svc -d thaliyola_prod < /root/thaliyola_prod-before-utf8.dump

sudo -u postgres psql -d thaliyola_prod -tAc "SELECT count(*) FROM articles"   # compare with the old database
sudo systemctl start thaliyola
```

When everything works for a few days: `sudo -u postgres psql -c "DROP DATABASE thaliyola_prod_sqlascii"`.

## The schema

The server applies the SQL files in [`apps/server/migrations`](../apps/server/migrations) in order on every start, under a Postgres advisory lock (so several replicas never run them twice), and records each in `schema_migrations`. There's nothing to run by hand, and a migration never runs twice. To apply them without starting the server: `node dist/db/migrate.js` with `DATABASE_URL` set (or `pnpm --filter @thaliyola/server migrate` from source).

Recent migrations:

| Migration | Adds |
|---|---|
| `071_agent_sessions.sql` | `agent_sessions` (registered Claude sessions: handle, project, repository, listening, last seen) and `session_questions` (questions between sessions, their claim, answer and delivery); the `question` notification kind |
| `072_design_systems.sql` | `design_systems` (one per scope: tokens as JSON, rules, `based_on`, version) and `design_system_versions` (every saved version, for restore) |

## After installing

1. Sign in as the Administrator and change the temporary password.
2. Open **Guide** (`#/guide`): it shows which features are switched on here and how to turn the others on.
3. Open **Connect** to connect Claude, or install the Claude Code plugin for the skill, the session hooks and the `/thaliyola` commands ([`integrations/README.md`](../integrations/README.md)).
4. Create projects, add their repositories, and invite the team.

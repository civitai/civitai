# Local dev setup: gotchas and fixes

The README's "Standard setup" gets you most of the way, but on a fresh clone (especially on
Windows) several things break in ways that don't point at their cause. This is everything we hit
setting up from scratch in Sept 2026, as **symptom → cause → fix**. It's written for humans and for
AI agents doing the setup; the agent checklist is at the end.

Items marked _(PR #NNNN)_ have an open fix upstream; until it merges, apply the workaround.

## Contents

1. [Toolchain](#1-toolchain)
2. [Docker services](#2-docker-services)
3. [Environment files](#3-environment-files)
4. [Migrations](#4-migrations)
5. [Seeding and search indexes](#5-seeding-and-search-indexes)
6. [Logging in (the auth hub)](#6-logging-in-the-auth-hub)
7. [The moderator app](#7-the-moderator-app)
8. [Things that don't work locally](#8-things-that-dont-work-locally)
9. [Updating an existing setup](#9-updating-an-existing-setup)
10. [Checklist for AI agents](#10-checklist-for-ai-agents)

---

## 1. Toolchain

**Node must match `.nvmrc` (24.19.0).** A different 24.x installs with only a warning and fails
later in confusing ways. On Windows, [fnm](https://github.com/Schniz/fnm) can switch per directory:
`winget install Schniz.fnm`, then add `eval "$(fnm env --use-on-cd --version-file-strategy=recursive --shell bash)"`
to `~/.bashrc` (Git Bash), and `fnm install` in the repo.

**`corepack enable` fails on Windows without admin** (`EPERM ... C:\Program Files\nodejs\yarn`).
Install pnpm directly at the `packageManager` version instead: `npm i -g pnpm@10.28.1`.

**Git Bash rewrites Unix paths in arguments.** `docker exec … /bin/sh` becomes
`C:/Program Files/Git/usr/bin/sh` and fails. Prefix such commands with `MSYS_NO_PATHCONV=1`.

**Playwright / browser-automation skill:** `npx playwright install chromium` once; it needs the
build matching the repo's Playwright version, not whatever is already installed.

## 2. Docker services

**`docker compose -f docker-compose.base.yml up -d` fails: "pull access denied for minio/minio".**
MinIO no longer publishes `minio/minio` or `minio/mc` (Docker Hub or quay.io). Compose aborts the
whole pull, so nothing starts. _(PR #5186)_ Workaround — a local override, e.g.
`docker-compose.local.yml` (add it to `.git/info/exclude`) and pass both files to every compose
command:

```yaml
services:
  minio:
    image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z # maintained drop-in fork
  createbuckets:
    image: pgsty/mc:RELEASE.2026-09-16T00-00-00Z
```

**Every ClickHouse query fails: "Authentication failed: password is incorrect".** The
`clickhouse-server` image disables network access for the passwordless `default` user unless
`CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` is set, but `.env-example` uses `default` with no password.
Add to the override:

```yaml
clickhouse:
  environment:
    - CLICKHOUSE_SKIP_USER_SETUP=1
```

**The images feed errors: "Meilisearch fetch failed (400): Unknown field `sort`".** The app sorts
via `/documents/fetch`, which Meilisearch v1.11 (the compose pin) doesn't support. Use a newer v1
(we use `getmeili/meilisearch:v1.35`). Data from 1.11 can't be opened by a newer version, so remove
the `<project>_meilisearch` volume and re-run the search bootstrap (§5).

**The auth hub can't reach Postgres: "The server does not support SSL connections".**
`apps/auth/src/lib/server/db/db.ts` always connects with `sslmode=no-verify` and ignores
`DATABASE_SSL=false`. Turn SSL on in the local Postgres (it stays optional for everything else):

```yaml
db:
  command: postgres -c ssl=on -c ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem -c ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key
```

## 3. Environment files

**`.env.development` is not enough for the dev-server skill.** The daemon reads `.env`. Keep both
(identical) — both are gitignored.

**On Windows, use `127.0.0.1`, not `localhost`, for backend services.** Prisma resolves `localhost`
to `::1`, and Docker Desktop publishes ports on IPv4 only, so Prisma reports "Can't reach database
server" while `pg` works. Change `DATABASE_URL`, `DATABASE_REPLICA_URL`, `NOTIFICATION_DB_URL*`,
`REDIS_URL`, `REDIS_SYS_URL`, `CLICKHOUSE_HOST`, `SEARCH_HOST`, `METRICS_SEARCH_HOST` (leave the
`localhost:3000` app URLs alone). The local-dev scripts' safety check only accepted `localhost`
_(PR #5187)_.

**Values the README tells you to fill in** (S3 keys, `WEBHOOK_TOKEN`, `EMAIL_*`). S3 keys can be
created without the MinIO console:
`mc admin accesskey create <alias> minioadmin --access-key <key> --secret-key <secret>`.

**Collection and user image feeds fail: "Having trouble loading images", and the server logs
`relation "CollectionItem" does not exist`.** Several image feeds read the "datapacket" read
replica (`DATAPACKET_DATABASE_RO_URL`, enabled for everyone by the `datapacketRead` feature flag).
`.env-example` points it at port 15435 — the `logical-db` container, a logical-replication stub
holding only `Image(id)` — so every such query fails. Locally there is no separate replica; point
it at the main database, as `DATABASE_REPLICA_URL` already does:
`DATAPACKET_DATABASE_RO_URL=postgresql://postgres:postgres@127.0.0.1:15432/civitai`.

**Settings missing from `.env-example`** — see §6 (auth hub) and §7 (moderator app). Watch for a
key that already exists further up the file: dotenv keeps the **first** occurrence, so appending a
second `MODERATOR_APP_URL=` silently does nothing.

## 4. Migrations

`make run-migrations` (= `scripts/local-dev/run_migrations.ts`) reports ~30 failures on a fresh DB.
Failed migrations aren't recorded, so you can retry them. Causes, in order of frequency:

1. **The runner sends each file as one query, so it runs in an implicit transaction.** Anything
   that can't run in a transaction fails: `CREATE/DROP INDEX CONCURRENTLY`, `VACUUM`, and adding an
   enum value then using it. **Fix:** apply those with `psql -f`, which runs statement by statement:
   `docker exec -i <db-container> psql -U postgres -d civitai -v ON_ERROR_STOP=1 < migration.sql`,
   then insert the row into `_prisma_migrations` yourself (name + sha256 of the file).
2. **Real bugs on a fresh database** (production applied these by hand):
   - `20251123142214_model_metric_overhaul` — missing comma after `"availability" = m."availability"`
     _(PR #5188)_; then the `DROP COLUMN timeframe` is blocked by the unused `ModelRank_Live` and
     `UserStat` views. Drop `ModelRank_Live`, apply `20251123233705_userstats_shrink` with
     `drop view … "UserStat" cascade` (also drops the unused `UserRank_Live`), then the overhaul.
   - `20260410140011_add_oauth_tables` — assumes no `OauthClient` table, but the baseline has a
     legacy one. Reshape it instead (add the new columns, make `secret` nullable) and run the rest
     of the file; the four later OAuth migrations then apply.
   - `add_challenge_review_cost`, `imagereport_imageid_fk` — the DB is already in the target
     state; just record them.
3. **The baseline schema (`containers/db`) is missing things** that migrations listed as "initial"
   (and therefore never run) were supposed to create: `BlockedImage`, `AdToken`,
   `Thread.commentCount`. Also `ModelVersionMetric`'s primary key was never migrated to
   `(modelVersionId)` (metrics jobs fail with "no unique or exclusion constraint matching the ON
   CONFLICT"), and `Image.modelRestricted` exists only in production (the models search index fails).
4. **Data-dependent migrations** (`HomeBlock` FKs, the writer leaderboard update) only apply after
   seeding — retry them after §5. The writer-leaderboard one deliberately raises when a production
   row is missing; record it.

A useful check afterwards:
`npx prisma migrate diff --from-url <DATABASE_URL> --to-schema-datamodel packages/civitai-db-schema/prisma/schema.prisma --script`
— ignore the large expected noise (raw-SQL indexes, views modelled as tables) and look only for
`CREATE TABLE` / `ADD COLUMN` on objects the app uses.

## 5. Seeding and search indexes

**`make reseed` → `gen_seed.ts` fails** _(PR #5187)_: it imports the deleted
`~/server/db/notifDb`, and its rows are positional, so columns dropped since it was written
(`Model.earlyAccessDeadline`, `ModelVersion.earlyAccessConfig/EndsAt`, `Tag.nsfw`) shift every
later value ("invalid input syntax for type boolean: "Created"").

**About half the seeded images show as broken red tiles.** The seed uses Faker's
`image.url()`, which picks loremflickr.com half the time; loremflickr now serves a 401 "Bot check"
page. Rewrite them, then clear caches and re-index:

```sql
UPDATE "Image" SET url = regexp_replace(url,
  '^https://loremflickr.com/([0-9]+)/([0-9]+)\?lock=([0-9]+)$', 'https://picsum.photos/seed/\3/\1/\2')
WHERE url LIKE 'https://loremflickr.com/%';
```

**The seed empties the `Role` table.** It runs `TRUNCATE "User" … CASCADE`, which also truncates
every table with a foreign key to `User` — including `Role`. Re-insert any roles you need (§7).

**No articles appear anywhere** (home page, `/articles`, search), and the `articles_v5` index is
empty. Every seeded article has `ingestion = 'Pending'`, and listing queries require `'Scanned'`;
the content scanner doesn't run locally. Mark the published ones scanned, then re-run the search
bootstrap:

```sql
UPDATE "Article" SET ingestion = 'Scanned', "contentScannedAt" = COALESCE("contentScannedAt", now())
WHERE status = 'Published' AND ingestion = 'Pending';
```

**Every home-page section is empty** (only the headings render). The seed doesn't set them up, and
they can't be fixed from the UI. Each is a `HomeBlock` row; what it needs:

- `Collection` blocks (`metadata.collection.id`) — that collection needs `ACCEPTED`
  `CollectionItem`s of the matching type. The seeded ones are empty or the wrong type (e.g. the
  Featured Posts block points at an empty 3D-model collection). Add published, PG
  (`"nsfwLevel" = 1`) items; for models, picking ones already in the `models_v9` index works best,
  since the block applies further visibility checks.
- `FeaturedModelVersion` — rows in `"FeaturedModelVersion"` whose `validFrom`/`validTo` window
  includes now; all seeded windows are in the past.
- `FeaturedCollections` — `metadata.featuredCollections.collectionIds` must list public collections
  that have items.
- The "New & Upcoming" `Feed` blocks — read the latest date of `"LeaderboardResult"` for the
  `images-new` and `new_creators` boards (filled daily by a job that doesn't run locally; the
  `images-new` `Leaderboard` row doesn't exist). Create the board and insert a day's rows of users
  with PG content.

Home blocks are cached in Redis: after editing, delete the `packed:*` keys (and
`home-blocks:featured-collections:*`).

**`make reseed` → bootstrap stops at the first failing job, so search stays empty**
_(PR #5187)_. Several metrics jobs read ClickHouse tables that only exist in production. Two can
be approximated locally so the models and images indexes build:

```sql
CREATE VIEW default.entityMetricEvents_month AS
  SELECT * FROM default.entityMetricEvents WHERE createdAt >= now() - INTERVAL 1 MONTH;
CREATE VIEW default.entityMetricDailyAgg_v2 AS
  SELECT entityType, entityId, metricType, toDate(createdAt) AS day, sum(metricValue) AS total
  FROM default.entityMetricEvents GROUP BY entityType, entityId, metricType, day;
```

Jobs needing `reactions_owner_scores` / `metricExcludedUsers` still fail (users, bounties, posts,
articles metrics) — expected locally.

## 6. Logging in (the auth hub)

The main app no longer signs anyone in; the hub (`apps/auth`, port 5173) does, and neither side's
settings are in the main `.env-example`.

- **`apps/auth/.env`**: copy `apps/auth/.env.example`, point `DATABASE_URL`/`REDIS_*` at the local
  services, set `AUTH_JWT_ISSUER=http://localhost:5173`,
  `AUTH_JWKS_URI=http://localhost:5173/api/auth/jwks`, `AUTH_DEFAULT_RETURN_URL=http://localhost:3000`,
  the same `NEXTAUTH_SECRET` as the main app, an `AUTH_INTERNAL_TOKEN`, and the maildev `EMAIL_*`.
  Generate an **EC P-256** key — the private key must be PKCS8 (`BEGIN PRIVATE KEY`):
  `openssl ecparam -genkey -name prime256v1 -noout -out sec1.pem && openssl pkcs8 -topk8 -nocrypt -in sec1.pem -out priv.pem && openssl ec -in sec1.pem -pubout -out pub.pem`
- **Main `.env`**: add `AUTH_JWT_ISSUER`, `AUTH_JWKS_URI` (same values) and the **same**
  `AUTH_INTERNAL_TOKEN`.
- **Dev-server skill**: in `.claude/skills/dev-server/.env` set `AUTH_HUB_ENABLED=true`, and set
  `HEALTH_CHECK_URL=http://localhost:{port}/api/health?token=<WEBHOOK_TOKEN>` — `/api/health`
  returns 401 without the token, so the session never reports ready.
- **Logging in**: use email. The magic link lands in maildev (http://localhost:1080; its API is
  `/api/email`, not `/email`). Make a user a moderator with `UPDATE "User" SET "isModerator" = true`.
  The session is cached, so sign in again (or wait) after changing the user row.

## 7. The moderator app

**⚠️ By default, the admin links take you to PRODUCTION.** Many `/moderator/*` pages moved to
`apps/moderator`; the main app redirects there using `MODERATOR_APP_URL`, which `.env-example`
sets to `https://moderator.civitai.com` (also the code default). Set, in the main `.env` (edit the
existing line rather than appending a second one, §3):

```
MODERATOR_APP_URL=http://localhost:5174
NEXT_PUBLIC_MODERATOR_APP_URL=http://localhost:5174
MOD_INBOUND_TOKEN=<random; same value in apps/moderator/.env>
```

- **`apps/moderator/.env`**: from its `.env.example` — auth values pointing at the local hub (same
  `AUTH_INTERNAL_TOKEN`), `WEBHOOK_TOKEN`, local DB/Redis/ClickHouse,
  `PUBLIC_IMAGE_LOCATION=http://localhost:3000`. Start it with
  `node .claude/skills/dev-server/cli.mjs start --app moderator`; confirm the `dbHost` it prints is
  local.
- **"Denied" on every page**: the app has its own permissions. Grant the super role:
  `INSERT INTO "Role"(id) VALUES ('moderator:admin') ON CONFLICT DO NOTHING;` then
  `INSERT INTO "UserRole"("userId", role) VALUES (<id>, 'moderator:admin');` (`Role` may be empty —
  see §5).
- Pages under **Retool** need `MODERATOR_DATABASE_URL`, a separate database not in the local stack.

## 8. Things that don't work locally

- **Notifications list** — the bell shows counts, but the list 500s ("No notifications endpoint
  configured"): the list comes from `apps/notifications` via `NOTIFICATIONS_ENDPOINT`, which isn't
  set up locally.
- **Flipt-gated features** (e.g. `/hubs` → 404). `FEATURE_FLAG_*` overrides are deliberately
  ignored for flags that have a `fliptKey`.
- Generation, training, Buzz and signals — see the README's "Known limitations".

**A route that hangs forever — and survives a restart.** Symptoms: signed-in pages take exactly
8 s and render as signed out (hydration-mismatch warnings follow), the image feed shows "Taking
longer than usual", and `/moderator/*` loops between the page and `/login` (`ERR_TOO_MANY_REDIRECTS`).
The cause is one route, `/api/user/settings`, which `_app` self-fetches on every SSR render with an
8 s timeout: requests to it never reach its handler, while every other route is fast. It is a
corrupted entry in Turbopack's persistent dev cache (`.next`), so a plain `restart` may not clear
it. Tells: `curl --max-time 10 localhost:3000/api/user/settings` times out even anonymously, the
server sits at ~0% CPU (waiting, not compiling), and an identical copy of the route at another path
answers fine. Fix: `node .claude/skills/dev-server/cli.mjs unwedge <session-id>` (purges `.next`
and restarts; the first page loads afterwards are a slow cold compile). The likely trigger is
switching git branches or editing/reverting that file while the dev server is running — use a
separate `git worktree` for side branches instead.

## 9. Updating an existing setup

1. **Stop the dev servers before `pnpm install`.** On Windows a running server holds Prisma's
   engine DLL and `prisma generate` fails with `EPERM … query_engine-windows.dll.node`.
2. `git fetch upstream && git merge --ff-only upstream/main`, then `git submodule update --init event-engine-common`.
3. **Apply new migrations by comparing folders against the DB**, not against a branch — list
   `packages/civitai-db-schema/prisma/migrations/*` and diff with
   `SELECT migration_name FROM "_prisma_migrations"`.
4. Re-check `.env-example`, `apps/*/.env.example` and `docker-compose.base.yml` for changes.
5. To sync a fork's `main`, `gh repo sync <you>/civitai -b main` avoids the full-typecheck
   pre-push hook that runs when you push `main` yourself.
6. Don't switch branches under a running dev server (see §8); stop it first, or work on other
   branches in a `git worktree`.

## 10. Checklist for AI agents

Don't report the setup as working until each of these is verified, not assumed:

- [ ] `node -v` matches `.nvmrc` in the shell that starts the dev-server daemon (it inherits that
      Node for good).
- [ ] All compose services are up; `createbuckets` exited 0.
- [ ] Every migration folder is in `_prisma_migrations`, and `prisma migrate diff` shows no
      missing tables/columns the app uses (§4).
- [ ] The seed ran to completion; the search bootstrap built `models_v9` and `metrics_images_v1`
      (check document counts in Meilisearch).
- [ ] `/api/health?token=<WEBHOOK_TOKEN>` reports every service `true`.
- [ ] Signed **out**: `/`, `/models`, `/images` load in a real browser with no broken images.
- [ ] Signed **in** (via the hub + maildev): `/api/auth/session` returns the user **quickly**,
      the image feed loads, and pages don't render signed-out.
- [ ] `/api/user/settings` answers in well under 8 s, anonymously and signed in (§8).
- [ ] A collection page's images load, `/articles` lists articles, and the home page sections
      have items (§3, §5).
- [ ] Admin links resolve to `localhost:5174`, not `moderator.civitai.com`.
- [ ] Nothing you did is in `git status` except intended changes — the env files and the compose
      override must stay untracked.

Watch for: a step that "succeeds" with a warning (pnpm engine mismatch, migration runner
"Failures: N"), a fix that only works because a cache or a recompile masked the problem, and any
default URL that points at a production host.

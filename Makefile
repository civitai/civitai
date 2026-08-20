# Compose derives its project name from the directory it runs in, so each git
# worktree would otherwise get its own stack -- and the second one to start dies
# on the port binds ("Bind for :::15434 failed: port is already allocated").
# Pinning it means every worktree shares the one local stack and the one local
# database, which is what the primary clone's directory name already produced.
# Override it if you genuinely want a second, isolated stack.
export COMPOSE_PROJECT_NAME ?= civitai

# Start the containers in the background
.PHONY: start
start:
	docker compose up -d

# Stop all containers
.PHONY: stop
stop:
	docker compose stop

# Remove containers
.PHONY: down
down:
	docker compose down

# Restart containers
.PHONY: restart
restart: stop start

# Rebuild the containers
.PHONY: rebuild
rebuild:
	docker compose down \
		&& docker compose up --build -d

# Stop and remove all containers, networks, images, and volumes
.PHONY: burn
burn:
	docker compose down \
		&& docker compose down --volumes

ROWS ?= 1000
TRUNC_QUEUE ?= true
# Initialize the database and seed it with data
.PHONY: bootstrap-db
bootstrap-db:
	npx cross-env NODE_ENV=development tsx ./scripts/local-dev/gen_seed.ts --rows=$(ROWS) --trunc=$(TRUNC_QUEUE)

# Run new migrations
.PHONY: run-migrations
run-migrations:
	npx cross-env NODE_ENV=development tsx ./scripts/local-dev/run_migrations.ts

# Trigger metrics and search data jobs
.PHONY: bootstrap-metrics
bootstrap-metrics:
	npx cross-env NODE_ENV=development tsx ./scripts/local-dev/bootstrap-metrics-search.ts

.PHONY: copy-env
copy-env:
	cp -u ./.env-example ./.env.development

# `npm i` cannot work here: package.json's `preinstall` runs `npx only-allow pnpm`,
# which exits 1 under npm. `make init` was dead on that line.
#
# This line previously carried `# TODO fix postinstall on git bash`. That note is
# preserved rather than dropped, because nothing has verified it either way: the
# target it sat on was DEAD for everyone (see above), so the `postinstall` hook it
# warned about -- `pnpm run db:generate`, i.e. generate-slim-schema.js then
# `prisma generate` -- has not been exercised here in a long time. Un-breaking the
# target does not fix whatever that was; it just means the next Windows contributor
# is the first to walk the path in a while.
#
# `.github/workflows/windows-dev-env.yml` now runs `pnpm install` on windows-latest
# under BOTH pwsh and Git Bash to find out. It is non-blocking. When it has been
# green for a while, delete this note; if it goes red under bash, this is the lead.
.PHONY: install
install:
	pnpm install

# Kept so `make npm-install` still does the right thing for anyone with it in
# their fingers. It installs with pnpm, because npm is refused.
.PHONY: npm-install
npm-install: install

# Must go through `db:generate`, not a bare `prisma generate`: the generate step
# reads packages/civitai-db-schema/prisma/schema.prisma, which is gitignored and
# produced by scripts/generate-slim-schema.js. On a fresh clone that file does
# not exist yet, so `prisma generate` alone has nothing to read. Going through
# pnpm also puts node_modules/.bin on PATH, which a bare `prisma` needs.
.PHONY: gen-prisma
gen-prisma:
	pnpm run db:generate

# Through `pnpm exec` so cross-env and next resolve from node_modules/.bin
# without the caller having to add it to PATH by hand.
.PHONY: dev
dev:
	pnpm exec cross-env NODE_OPTIONS=--disable-warning=ExperimentalWarning next dev

.PHONY: run
run: gen-prisma dev

.PHONY: reseed
reseed: bootstrap-db bootstrap-metrics

.PHONY: init
init: copy-env install start run-migrations reseed run

.PHONY: rerun
rerun: start reseed dev

.PHONY: init-devcontainer
init-devcontainer: copy-env install run-migrations reseed

.PHONY: default
default: start

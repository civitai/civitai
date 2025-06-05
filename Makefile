# Start the containers in the background
.PHONY: start
start:
	docker-compose up -d

# Stop all containers
.PHONY: stop
stop:
	docker-compose stop

# Remove containers
.PHONY: down
down:
	docker-compose down

# Restart containers
.PHONY: restart
restart: stop start

# Rebuild the containers
.PHONY: rebuild
rebuild:
	docker-compose down \
		&& docker-compose up --build -d

# Stop and remove all containers, networks, images, and volumes
.PHONY: burn
burn:
	docker-compose down \
		&& docker-compose down --volumes

ROWS ?= 1000
# Initialize the database and seed it with data
.PHONY: bootstrap-db
bootstrap-db:
	npx cross-env NODE_ENV=development tsx ./scripts/local-dev/gen_seed.ts --rows=$(ROWS)

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

.PHONY: npm-install
npm-install:
	# TODO fix postinstall on git bash
	npm i

.PHONY: gen-prisma
gen-prisma:
	prisma generate --no-hints

.PHONY: dev
dev:
	cross-env NODE_OPTIONS=\"--disable-warning=ExperimentalWarning\" next dev

.PHONY: run
run: gen-prisma dev

.PHONY: reseed
reseed: bootstrap-db bootstrap-metrics

.PHONY: init
init: copy-env npm-install start run-migrations reseed run

.PHONY: rerun
rerun: start reseed dev

.PHONY: init-devcontainer
init-devcontainer: copy-env npm-install run-migrations reseed

.PHONY: default
default: start

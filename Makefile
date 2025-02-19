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

# Initialize the database and seed it with data
.PHONY: bootstrap-db
bootstrap-db:
	npx cross-env NODE_ENV=development tsx ./scripts/local-dev/gen_seed.ts

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
	npm i

.PHONY: run
run:
	npm run db:generate
	npm run dev

.PHONY: init
init: copy-env npm-install start run-migrations bootstrap-db bootstrap-metrics run

.PHONY: rerun
rerun: start bootstrap-db
	npm run dev

.PHONY: init-devcontainer
init-devcontainer: copy-env npm-install run-migrations bootstrap-db bootstrap-metrics

.PHONY: default
default: start

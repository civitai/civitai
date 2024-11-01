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
	cross-env NODE_ENV=development npx tsx ./scripts/gen_seed.ts

# Run new migrations
.PHONY: run-migrations
run-migrations:
	cross-env NODE_ENV=development npx tsx ./scripts/run_migrations.ts

# Trigger metrics and search data jobs
.PHONY: bootstrap-metrics
bootstrap-metrics:
	cross-env NODE_ENV=development npx tsx ./scripts/bootstrap-metrics-search.ts

.PHONY: copy-env
copy-env:
	cp -u ./.env-example ./.env.development

.PHONY: init
init: copy-env start bootstrap-db run-migrations bootstrap-metrics
	npm i
	npm run db:generate
	npm run dev

.PHONY: default
default: start

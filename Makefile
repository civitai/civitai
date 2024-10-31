# Start the containers in the background
.PHONY: start
start:
	docker-compose up -d

# Stop all containers
.PHONY: stop
stop:
	docker-compose stop

# shut down
.PHONY: down
down:
	docker-compose down

# restart
.PHONY: restart
restart: down start

# Rebuilds the containers
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
	NODE_ENV=development npx tsx ./scripts/gen_seed.ts

# Trigger metrics and search data jobs
.PHONY: bootstrap-metrics
bootstrap-metrics:
	NODE_ENV=development npx tsx ./scripts/bootstrap-metrics-search.ts

.PHONY: default
default: start

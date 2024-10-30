# Start the containers in the background
start:
	docker-compose up -d

# Initialize the database and seed it with data
bootstrap-db:
	NODE_ENV=development npx tsx ./scripts/gen_seed.ts

# Trigger metrics and search data jobs
bootstrap-metrics:
	NODE_ENV=development npx tsx ./scripts/bootstrap-metrics-search.ts

# Stop all containers
stop:
	docker-compose stop

# Stop and remove all containers, networks, images, and volumes
burn:
	docker-compose down \
		&& docker-compose down --volumes

default: start

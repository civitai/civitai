# Kubernetes Deployment Guide for Metric Event Watcher

This directory contains Kubernetes manifests for deploying the metric event watcher infrastructure using the Strimzi Kafka operator.

## Components

All components run in a single `metric-watcher` namespace for easy management:

- **Strimzi Kafka Operator**: Manages Kafka clusters in Kubernetes
- **Kafka Cluster**: Single-node Kafka cluster with persistent storage
- **Kafka Connect with Debezium**: For CDC (Change Data Capture) from PostgreSQL
- **ClickHouse Kafka Engine**: Native ClickHouse integration for producing/consuming Kafka messages
- **Kafka UI**: Web interface for managing and monitoring Kafka
- **Storage Classes**: Persistent storage configuration
- **Metric Event Watcher Application**: The main application deployment

## Prerequisites

1. Kubernetes cluster (1.23+)
2. kubectl configured to access your cluster
3. NGINX Ingress Controller (for Kafka UI access)

## Installation Steps

### 1. Setup GitHub Container Registry

The application image is automatically built and pushed to GitHub Container Registry (ghcr.io) via GitHub Actions.

#### Option A: Automatic Build (Recommended)
Push your code to GitHub and let the workflow build and publish the image:
```bash
git push origin main
```

The workflow will:
- Build multi-platform images (amd64, arm64)
- Push to `ghcr.io/civitai/metric-event-watcher:latest`
- Tag with branch name and commit SHA
- Run security scans with Trivy

#### Option B: Manual Build
If you need to build manually:
```bash
# Login to GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin

# Build and push
docker build -t ghcr.io/civitai/metric-event-watcher:latest .
docker push ghcr.io/civitai/metric-event-watcher:latest
```

### 2. Configure Image Pull Secret

Create a secret for pulling images from GitHub Container Registry:
```bash
# First, create a GitHub Personal Access Token (PAT) with 'read:packages' scope
# Then create the secret (update the values in 12-ghcr-secret.yml first)
kubectl apply -f 12-ghcr-secret.yml

# Or create directly via kubectl:
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USERNAME \
  --docker-password=YOUR_GITHUB_PAT \
  --docker-email=YOUR_EMAIL \
  -n metric-watcher
```

### 3. Create Namespace
```bash
kubectl apply -f 00-namespace.yml
```

### 4. Install Strimzi Operator
```bash
# Install Strimzi operator in the metric-watcher namespace
kubectl apply -f 'https://strimzi.io/install/latest?namespace=metric-watcher' -n metric-watcher
```

Wait for the operator to be ready:
```bash
kubectl wait --for=condition=Ready pod -l name=strimzi-cluster-operator -n metric-watcher --timeout=300s
```

### 5. Deploy Kafka Cluster
```bash
# Apply KafkaNodePool resources first (for KRaft mode)
kubectl apply -f 02-kafka-nodepool.yml

# Then apply the Kafka cluster
kubectl apply -f 02-kafka-cluster.yml
```

Wait for Kafka to be ready:
```bash
kubectl wait --for=condition=Ready kafka/metric-watcher-cluster -n metric-watcher --timeout=600s
```

### 6. Deploy Kafka Connect with Debezium
```bash
kubectl apply -f 03-kafka-connect-debezium.yml
```

Wait for Kafka Connect to be ready:
```bash
kubectl wait --for=condition=Ready kafkaconnect/debezium-connect-cluster -n metric-watcher --timeout=600s
```

### 7. Deploy Kafka UI
```bash
kubectl apply -f 04-kafka-ui.yml
```

### 8. Apply Secrets and ConfigMaps
```bash
# IMPORTANT: Review and update credentials before applying
kubectl apply -f 07-secrets.yml
kubectl apply -f 08-configmap.yml
```

### 9. Debezium Connector Configuration (Automatic)

The application **automatically configures Debezium** when the consumer starts. The consumer uses the `DebeziumManager` service to:
- Check if Debezium Connect is available
- Create or update the PostgreSQL connector configuration as needed
- Ensure all required Kafka topics exist
- Monitor connector health and restart if necessary

This means:
- **No manual setup required** - just deploy the application
- **Single source of truth** - monitored tables are defined in `src/services/debezium-manager.ts`
- **Self-healing** - the connector is automatically reconfigured if it fails or drifts from desired state

To verify Debezium configuration after deployment:
```bash
# Check Kafka Connect logs
kubectl logs deployment/debezium-connect-cluster-connect -n metric-watcher

# Check consumer logs for Debezium setup messages
kubectl logs deployment/metric-event-watcher -n metric-watcher | grep -i debezium

# Use port-forward to access Kafka Connect REST API
kubectl port-forward svc/debezium-connect-cluster-connect-api 8083:8083 -n metric-watcher

# Then check connector status
curl http://localhost:8083/connectors/civitai-postgres-connector/status
```

### 10. Configure ClickHouse Kafka Engine
ClickHouse uses its native Kafka Engine instead of Debezium. Execute the SQL commands in `11-clickhouse-kafka-setup.sql` on your ClickHouse instance:
```bash
# Connect to your ClickHouse instance and run:
clickhouse-client --host your-clickhouse-host \
                  --port 8443 \
                  --user default \
                  --password PASSWORD \
                  --secure \
                  --queries-file k8s/11-clickhouse-kafka-setup.sql
```

### 11. Deploy Application
```bash
kubectl apply -f 09-metric-watcher-app.yml
```

The application will:
1. Start the consumer pods
2. Automatically configure Debezium connector on first startup
3. Begin consuming messages from Kafka topics
4. Process events using the worker pool

## Access Kafka UI

### Using Port Forward
```bash
kubectl port-forward svc/kafka-ui 8080:8080 -n metric-watcher
```
Access at: http://localhost:8080

### Using Ingress
If you have NGINX Ingress configured, add this to your hosts file:
```
<INGRESS_IP> kafka-ui.metric-watcher.local
```
Access at: http://kafka-ui.metric-watcher.local

## Kafka Access

### Internal Access (within cluster)
- Bootstrap servers: `metric-watcher-cluster-kafka-bootstrap.metric-watcher.svc:9092`
- Zookeeper: `metric-watcher-cluster-zookeeper-client.metric-watcher.svc:2181`

### External Access (NodePort)
- Kafka Bootstrap: `<NODE_IP>:30092`
- Kafka Broker 0: `<NODE_IP>:30093`
- Debezium Connect: `<NODE_IP>:30083` (⚠️ May require firewall configuration)
- Kafka UI: `<NODE_IP>:30080`

**Note**: If Debezium Connect NodePort doesn't work due to firewall restrictions, use port-forward instead:
```bash
kubectl port-forward svc/debezium-connect-cluster-connect-api 8083:8083 -n metric-watcher
```

## Managing Connectors

### PostgreSQL Debezium Connector

The PostgreSQL connector is automatically managed by the application via `DebeziumManager`.

To interact with the connector directly via REST API:
```bash
# Port-forward to Kafka Connect
kubectl port-forward svc/debezium-connect-cluster-connect-api 8083:8083 -n metric-watcher

# List connectors
curl http://localhost:8083/connectors

# Get connector status
curl http://localhost:8083/connectors/civitai-postgres-connector/status

# Restart connector (if needed)
curl -X POST http://localhost:8083/connectors/civitai-postgres-connector/restart

# Delete connector (will be recreated on next consumer restart)
curl -X DELETE http://localhost:8083/connectors/civitai-postgres-connector
```

### ClickHouse Kafka Engine

ClickHouse doesn't use Debezium. Instead, configure Kafka tables directly in ClickHouse:

#### Create Kafka producer table
```sql
-- Creates a table that writes to Kafka
CREATE TABLE kafka_metrics_queue (...) ENGINE = Kafka()
SETTINGS kafka_broker_list = 'kafka-broker:9092', ...
```

#### Create Kafka consumer table
```sql
-- Creates a table that reads from Kafka
CREATE TABLE kafka_events_consumer (...) ENGINE = Kafka()
SETTINGS kafka_broker_list = 'kafka-broker:9092', ...
```

See `11-clickhouse-kafka-setup.sql` for complete examples.

## Scaling

### Scale Kafka brokers
Edit the Kafka resource:
```bash
kubectl edit kafka metric-watcher-cluster -n metric-watcher
```
Change `spec.kafka.replicas` to desired number.

### Scale Kafka Connect workers
Edit the KafkaConnect resource:
```bash
kubectl edit kafkaconnect debezium-connect-cluster -n metric-watcher
```
Change `spec.replicas` to desired number.

## Monitoring

The deployment includes JMX metrics exporters for Prometheus. Metrics are exposed at:
- Kafka: Port 9404
- Zookeeper: Port 9404
- Kafka Connect: Port 9404

## Troubleshooting

### Check operator logs
```bash
kubectl logs deployment/strimzi-cluster-operator -n metric-watcher
```

### Check Kafka logs
```bash
kubectl logs metric-watcher-cluster-kafka-0 -n metric-watcher
```

### Check Kafka Connect logs
```bash
kubectl logs deployment/debezium-connect-cluster-connect -n metric-watcher
```

### Check connector status
```bash
kubectl describe kafkaconnector <connector-name> -n metric-watcher
```

## Cleanup

To remove all components:
```bash
# Delete all resources in the namespace
kubectl delete -f . --recursive -n metric-watcher

# Delete the entire namespace (this will remove everything)
kubectl delete namespace metric-watcher

# Note: CRDs are cluster-wide and need to be deleted separately if desired
kubectl delete crd -l app.kubernetes.io/name=strimzi
```

## GitHub Actions Setup

1. **Required Secrets**:
   - `KUBE_CONFIG`: Base64-encoded kubeconfig file for kubectl access
   - GitHub automatically provides `GITHUB_TOKEN` for package registry access

2. **Workflow Features**:
   - Automatic builds on push to main/develop branches
   - Multi-platform support (amd64, arm64)
   - Semantic versioning with git tags
   - Security scanning with Trivy
   - Automatic deployment to K8s on main branch
   - Pull request builds (without push)

3. **To Enable**:
   ```bash
   # Copy the workflow to .github/workflows/
   mkdir -p .github/workflows
   cp docs/reference/github-workflow-example.yml .github/workflows/docker-build.yml

   # Add KUBE_CONFIG secret in GitHub repository settings
   cat ~/.kube/config | base64 | pbcopy  # Copy to clipboard
   # Go to Settings > Secrets > Actions > New repository secret
   ```

## Security Considerations

1. **Secrets Management**:
   - **IMPORTANT**: The `07-secrets.yml` and `12-ghcr-secret.yml` files contain sensitive credentials
   - Do not commit these files to version control
   - Consider using Kubernetes Secrets management solutions (Sealed Secrets, External Secrets Operator, HashiCorp Vault)
2. **Network Policies**: Consider adding network policies to restrict traffic
3. **TLS**: Enable TLS for production deployments
4. **RBAC**: Review and restrict permissions as needed
5. **Resource Limits**: Adjust resource requests/limits based on workload

## Configuration Notes

- **KRaft Mode**: Kafka runs without ZooKeeper using KRaft consensus (Kafka 3.9.0+)
- **Node Pools**: Separate controller (10Gi) and broker (20Gi) nodes for better resource management
- **Replication Factor**: Set to 1 (single node). For production, increase replicas and replication factors
- **Auto Topic Creation**: Disabled for better control. Create topics explicitly
- **PostgreSQL**: Uses Debezium for CDC with JSON format (no schemas)
- **ClickHouse**: Uses native Kafka Engine tables for producing/consuming messages
- **Message Formats**: The application handles different formats from PostgreSQL (Debezium) and ClickHouse (native)
- **Monitored Tables**: Configured in `src/services/debezium-manager.ts` as `MONITORED_TABLES` constant
- **Self-Configuring**: The consumer automatically sets up Debezium on startup, eliminating manual configuration
import axios from 'axios';
import { Kafka } from 'kafkajs';
import { logger } from '@/utils/logger';
import { config } from '@/config';

interface ConnectorConfig {
  name: string;
  config: Record<string, string>;
}

interface ConnectorStatus {
  name: string;
  connector: {
    state: string;
    worker_id: string;
  };
  tasks: Array<{
    id: number;
    state: string;
    worker_id: string;
    trace?: string;
  }>;
  type: string;
}

export class DebeziumManager {
  private static instance: DebeziumManager;
  private readonly connectorName = 'civitai-postgres-connector';
  private readonly debeziumUrl: string;
  private readonly kafka: Kafka;
  private isConfigured = false;


  private constructor() {
    this.debeziumUrl = process.env.DEBEZIUM_CONNECT_URL || 'http://localhost:8083';
    const kafkaBrokers = process.env.KAFKA_BROKERS || 'localhost:9092';

    this.kafka = new Kafka({
      clientId: 'debezium-manager',
      brokers: kafkaBrokers.split(','),
    });
  }

  public static getInstance(): DebeziumManager {
    if (!DebeziumManager.instance) {
      DebeziumManager.instance = new DebeziumManager();
    }
    return DebeziumManager.instance;
  }

  /**
   * Ensures Debezium connector is properly configured
   * Called automatically when consumer starts
   */
  public async ensureConnectorConfigured(): Promise<void> {
    if (this.isConfigured) {
      return;
    }

    // Skip if Debezium Connect URL is not configured
    if (!process.env.DEBEZIUM_CONNECT_URL) {
      logger.info('ℹ️ DEBEZIUM_CONNECT_URL not configured. Skipping connector setup.');
      logger.info('   Assuming Debezium connector is already configured externally.');
      this.isConfigured = true;
      return;
    }

    try {
      logger.info('🔍 Checking Debezium connector configuration...');

      // Check if Debezium Connect is available
      const isAvailable = await this.checkDebeziumAvailability();
      if (!isAvailable) {
        logger.warn('⚠️ Debezium Connect is not available. Skipping connector configuration.');
        logger.warn(`   Tried to connect to: ${this.debeziumUrl}`);
        return;
      }

      // Check existing connector
      const existingConfig = await this.getConnectorConfig();
      const desiredConfig = this.buildConnectorConfig();

      if (existingConfig) {
        // Validate existing configuration
        const needsUpdate = this.configNeedsUpdate(existingConfig, desiredConfig);

        if (needsUpdate) {
          logger.info('🔄 Updating Debezium connector configuration...');
          await this.updateConnector(desiredConfig);
        } else {
          logger.info('✅ Debezium connector is already properly configured');
        }

        // Check connector health
        const status = await this.getConnectorStatus();
        if (status && status.connector.state !== 'RUNNING') {
          logger.warn(`⚠️ Connector is in ${status.connector.state} state, attempting restart...`);
          await this.restartConnector();
        }
      } else {
        logger.info('📝 Creating new Debezium connector...');
        await this.createConnector(desiredConfig);

        // Wait a moment for connector to initialize
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verify the connector was actually created
        const verifyConfig = await this.getConnectorConfig();
        if (!verifyConfig) {
          throw new Error('Connector creation failed - connector not found after creation');
        }

        // Check initial status
        const status = await this.getConnectorStatus();
        logger.info(`📊 Connector initial status: ${status?.connector?.state || 'UNKNOWN'}`);
      }

      // Create required Kafka topics first (before connector tries to use them)
      await this.ensureTopicsExist();

      // Wait for topics to be ready
      await new Promise(resolve => setTimeout(resolve, 2000));

      this.isConfigured = true;
      logger.info('✅ Debezium connector setup complete')

    } catch (err) {
      if (axios.isAxiosError(err)) {
        logger.error({
          err,
          response: err.response?.data,
          status: err.response?.status
        }, '❌ Failed to configure Debezium connector - Axios error');
      } else {
        logger.error({ err }, '❌ Failed to configure Debezium connector');
      }
      throw err;
    }
  }

  private async checkDebeziumAvailability(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.debeziumUrl}/`, { timeout: 5000 });
      logger.info(`📡 Connected to Debezium Connect version: ${response.data.version}`);
      return true;
    } catch (err) {
      return false;
    }
  }

  private buildConnectorConfig(): ConnectorConfig {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not defined');
    }

    const dbUrlParts = new URL(databaseUrl);
    const username = dbUrlParts.username;
    const password = dbUrlParts.password;
    let hostname = dbUrlParts.hostname;
    const port = dbUrlParts.port || '5432';
    const database = dbUrlParts.pathname.slice(1).split('?')[0];

    // Log the database connection details (without password)
    logger.info(`📝 Configuring Debezium for database: ${username}@${hostname}:${port}/${database}`);

    // Handle localhost in Docker/Kubernetes environments
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      if (process.env.KUBERNETES_SERVICE_HOST) {
        // In Kubernetes, localhost won't work
        throw new Error('Database is configured as localhost but running in Kubernetes. Please use external hostname.');
      } else {
        // In Docker, use host.docker.internal
        hostname = 'host.docker.internal';
        logger.info('   Using host.docker.internal for Docker environment');
      }
    }

    return {
      name: this.connectorName,
      config: {
        'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
        'database.hostname': hostname,
        'database.port': port,
        'database.user': username,
        'database.password': password,
        'database.dbname': database,
        'database.server.name': 'civitai',
        'table.include.list': config.kafka.monitoredTables.join(','),
        'plugin.name': 'pgoutput',
        'publication.name': 'debezium_publication',
        'publication.autocreate.mode': 'filtered',
        'slot.name': process.env.DEBEZIUM_SLOT ?? 'debezium_slot',
        'topic.prefix': 'civitai',
        'decimal.handling.mode': 'precise',
        'time.precision.mode': 'adaptive',
        'heartbeat.interval.ms': '10000',
        'snapshot.mode': 'never',
        'tombstones.on.delete': 'false',
        'key.converter': 'org.apache.kafka.connect.json.JsonConverter',
        'value.converter': 'org.apache.kafka.connect.json.JsonConverter',
        'key.converter.schemas.enable': 'false',
        'value.converter.schemas.enable': 'false',
        'include.before.state': 'true',
        'transforms': 'route',
        'transforms.route.type': 'org.apache.kafka.connect.transforms.RegexRouter',
        'transforms.route.regex': 'civitai\\.public\\.(.*)',
        'transforms.route.replacement': 'postgres.$1',
        // Aim to reduce rep lag
        'flush.lsn.commit.interval.ms': '1000',     // advance LSN every 1s instead of ~5s
        'offset.flush.interval.ms': '5000',         // commit offsets to Kafka every 5s (default is 60s)
        'max.batch.size': '1024'                    // optional: smaller batches so commits happen more often
      }
    };
  }

  private async getConnectorConfig(): Promise<ConnectorConfig | null> {
    try {
      const response = await axios.get(`${this.debeziumUrl}/connectors/${this.connectorName}/config`);
      return {
        name: this.connectorName,
        config: response.data
      };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  private configNeedsUpdate(existing: ConnectorConfig, desired: ConnectorConfig): boolean {
    // Check if critical configuration has changed
    const criticalFields = [
      'table.include.list',
      'database.hostname',
      'database.port',
      'database.dbname',
      'topic.prefix',
    ];

    for (const field of criticalFields) {
      if (existing.config[field] !== desired.config[field]) {
        logger.info(`📝 Configuration change detected in ${field}`);
        logger.info(`   Current: ${existing.config[field]}`);
        logger.info(`   Desired: ${desired.config[field]}`);
        return true;
      }
    }

    return false;
  }

  private async createConnector(config: ConnectorConfig): Promise<void> {
    try {
      await axios.post(
        `${this.debeziumUrl}/connectors`,
        config,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
      logger.info(`✅ Created connector: ${config.name}`);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.data) {
        logger.error({
          err,
          response: err.response.data,
          message: err.response.data.message
        }, '❌ Debezium connector creation failed');
      }
      throw err;
    }
  }

  private async updateConnector(config: ConnectorConfig): Promise<void> {
    // Delete and recreate is safer than PUT for config changes
    await this.deleteConnector();
    await this.createConnector(config);
  }

  private async deleteConnector(): Promise<void> {
    try {
      await axios.delete(`${this.debeziumUrl}/connectors/${this.connectorName}`);
      logger.info(`🗑️ Deleted existing connector: ${this.connectorName}`);
      // Wait for deletion to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      if (!axios.isAxiosError(err) || err.response?.status !== 404) {
        throw err;
      }
    }
  }

  private async getConnectorStatus(): Promise<ConnectorStatus | null> {
    try {
      const response = await axios.get(`${this.debeziumUrl}/connectors/${this.connectorName}/status`);
      return response.data;
    } catch (err) {
      return null;
    }
  }

  private async restartConnector(): Promise<void> {
    try {
      await axios.post(`${this.debeziumUrl}/connectors/${this.connectorName}/restart`);
      logger.info('🔄 Restarted connector');
    } catch (err) {
      logger.error({ err }, 'Failed to restart connector');
    }
  }

  private async ensureTopicsExist(): Promise<void> {
    const admin = this.kafka.admin();

    try {
      await admin.connect();
      logger.info('📊 Checking/creating Kafka topics...');

      const existingTopics = await admin.listTopics();
      const topicsToCreate = [];

      // Add heartbeat topic
      if (!existingTopics.includes('__debezium-heartbeat.civitai')) {
        topicsToCreate.push({
          topic: '__debezium-heartbeat.civitai',
          numPartitions: 1,
          replicationFactor: 1,
          configEntries: [{ name: 'min.insync.replicas', value: '1' }]
        });
      }

      // Add data topics
      for (const table of config.kafka.monitoredTables) {
        const tableName = table.replace('public.', '');
        const topicName = `postgres.${tableName}`;

        if (!existingTopics.includes(topicName)) {
          topicsToCreate.push({
            topic: topicName,
            numPartitions: 1,
            replicationFactor: 1,
            configEntries: [{ name: 'min.insync.replicas', value: '1' }]
          });
        }
      }

      if (topicsToCreate.length > 0) {
        await admin.createTopics({
          topics: topicsToCreate,
          waitForLeaders: true
        });
        logger.info(`   Created ${topicsToCreate.length} Kafka topics`);
      } else {
        logger.info('   All required topics already exist');
      }

      await admin.disconnect();
    } catch (err) {
      logger.error({ err }, 'Failed to create Kafka topics');
      await admin.disconnect();
      // Don't throw - topics might be auto-created by Kafka
      logger.warn('⚠️ Topic creation failed, but continuing (topics may be auto-created)');
    }
  }

  /**
   * Get list of topics that should be consumed based on monitored tables
   */
  public static getTopicsToConsume(): string[] {
    return config.kafka.monitoredTables.map(table => {
      const tableName = table.replace('public.', '');
      return `postgres.${tableName}`;
    });
  }

  /**
   * Check if connector is healthy
   */
  public async isHealthy(): Promise<boolean> {
    try {
      const status = await this.getConnectorStatus();
      return status?.connector.state === 'RUNNING' &&
             status.tasks.every(task => task.state === 'RUNNING');
    } catch {
      return false;
    }
  }
}
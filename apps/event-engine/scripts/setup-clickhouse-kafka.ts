import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

dotenv.config();

interface KafkaTableConfig {
  tableName: string;
  topic: string;
  targetTable: string;
  materializedViewSQL: string;
}

async function setupClickhouseKafka() {
  const clickhouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    throw new Error('CLICKHOUSE_URL is not defined');
  }

  const kafkaBrokers = process.env.KAFKA_BROKERS || 'localhost:9092';

  const client = createClient({
    url: clickhouseUrl,
  });

  const kafkaEngineSettings = `
    kafka_broker_list = '${kafkaBrokers}',
    kafka_topic_list = '{{TOPIC}}',
    kafka_group_name = 'clickhouse_consumer',
    kafka_format = 'JSONEachRow',
    kafka_skip_broken_messages = 100
  `;

  const kafkaTables: KafkaTableConfig[] = [
    {
      tableName: 'kafka_modelVersionEvents',
      topic: 'clickhouse.modelVersionEvents',
      targetTable: 'modelVersionEvents',
      materializedViewSQL: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_modelVersionEvents
        TO modelVersionEvents
        AS SELECT
          type,
          time,
          userId,
          modelId,
          modelVersionId,
          nsfw,
          ip,
          userAgent,
          earlyAccess,
          deviceId
        FROM kafka_modelVersionEvents
        WHERE type = 'Download'
      `
    },
    {
      tableName: 'kafka_orchestration_jobs',
      topic: 'clickhouse.orchestration.jobs',
      targetTable: 'orchestration.jobs',
      materializedViewSQL: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_orchestration_jobs
        TO orchestration.jobs
        AS SELECT
          jobId,
          userId,
          jobType,
          createdAt,
          completedAt,
          provider,
          issuedBy,
          cost,
          creatorsTip,
          resourcesUsed,
          remixOfId,
          serviceUpgradeFee,
          claimDuration,
          blobsCount
        FROM kafka_orchestration_jobs
        WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')
      `
    },
    {
      tableName: 'kafka_buzz_resource_compensation',
      topic: 'clickhouse.buzz_resource_compensation',
      targetTable: 'buzz_resource_compensation',
      materializedViewSQL: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS mv_buzz_resource_compensation
        TO entityMetricEvents
        AS SELECT
          'Model' AS entityType,
          resourceId AS entityId,
          userId,
          'earnedAmount' AS metricType,
          amount AS metricValue,
          createdAt
        FROM kafka_buzz_resource_compensation
      `
    }
  ];

  try {
    console.log('Setting up Clickhouse Kafka tables and materialized views...\n');

    for (const config of kafkaTables) {
      console.log(`Setting up ${config.tableName}...`);

      const createKafkaTableQuery = `
        CREATE TABLE IF NOT EXISTS ${config.tableName} (
          type String,
          time DateTime,
          userId Int32,
          modelId Int32,
          modelVersionId Int32,
          nsfw Bool,
          ip String,
          userAgent String,
          earlyAccess Bool,
          deviceId String,
          jobId String,
          jobType String,
          createdAt DateTime64(3),
          completedAt DateTime64(3),
          provider String,
          issuedBy String,
          cost Float64,
          creatorsTip Nullable(Float64),
          resourcesUsed Array(Int32),
          remixOfId Nullable(String),
          serviceUpgradeFee Nullable(Int16),
          claimDuration Float32,
          blobsCount Int16,
          resourceId Int32,
          amount Int32
        ) ENGINE = Kafka
        SETTINGS ${kafkaEngineSettings.replace('{{TOPIC}}', config.topic)}
      `;

      try {
        await client.exec({
          query: createKafkaTableQuery,
        });
        console.log(`  ✓ Kafka table ${config.tableName} created`);
      } catch (error: any) {
        if (error.message?.includes('already exists')) {
          console.log(`  - Kafka table ${config.tableName} already exists`);
        } else {
          throw error;
        }
      }

      try {
        await client.exec({
          query: config.materializedViewSQL,
        });
        console.log(`  ✓ Materialized view for ${config.tableName} created`);
      } catch (error: any) {
        if (error.message?.includes('already exists')) {
          console.log(`  - Materialized view for ${config.tableName} already exists`);
        } else {
          throw error;
        }
      }
    }

    console.log('\n✅ Clickhouse Kafka setup complete!');

    console.log('\nVerifying tables...');
    const result = await client.query({
      query: `
        SELECT name, engine
        FROM system.tables
        WHERE database = currentDatabase()
          AND (engine LIKE '%Kafka%' OR name LIKE 'mv_%')
        ORDER BY name
      `,
      format: 'JSONEachRow',
    });

    const tables = await result.json();
    console.log('Created tables and views:');
    tables.forEach((table: any) => {
      console.log(`  - ${table.name} (${table.engine})`);
    });

  } catch (error) {
    console.error('Error setting up Clickhouse Kafka:', error);
    throw error;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  setupClickhouseKafka().catch((error) => {
    console.error('Failed to setup Clickhouse Kafka:', error);
    process.exit(1);
  });
}

export { setupClickhouseKafka };
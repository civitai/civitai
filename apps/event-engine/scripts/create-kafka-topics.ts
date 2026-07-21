import { Kafka, Admin, ITopicConfig } from 'kafkajs';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Define the topics that need to be created
const TOPICS = [
  // ClickHouse integration topics
  'clickhouse.jobs',
  'clickhouse.manual_events',
  'clickhouse.modelVersionEvents',
  'postgres.Article',
  'postgres.ArticleReaction',
  'postgres.Bounty',
  'postgres.BountyBenefactor',
  'postgres.BountyEngagement',
  'postgres.BountyEntry',
  'postgres.BountyEntryReaction',
  'postgres.BuzzTip',
  'postgres.CollectionContributor',
  'postgres.CollectionItem',
  'postgres.Comment',
  'postgres.CommentV2',
  'postgres.ImageReaction',
  'postgres.ImageResourceNew',
  'postgres.Outbox',
  'postgres.ResourceReview',
  'postgres.TagEngagement',
  'postgres.TagsOnArticle',
  'postgres.TagsOnBounty',
  'postgres.TagsOnImageNew',
  'postgres.TagsOnModels',
  'postgres.TagsOnPost',
  'postgres.UserEngagement',
  'orchestrator.imageScanned',
  'orchestrator.processorFailed',
];

// Topic configuration matching debezium-manager settings
const TOPIC_CONFIG = {
  numPartitions: 1,
  replicationFactor: 1,
  configEntries: [
    { name: 'min.insync.replicas', value: '1' }
  ]
};

async function createKafkaTopics(topicsToSetup: string[] = TOPICS) {
  // Get Kafka broker from environment - should be set in .env
  const kafkaBrokers = process.env.KAFKA_BROKERS || 'localhost:9092';

  console.log('🚀 Initializing Kafka admin client...');
  console.log(`📡 Kafka brokers: ${kafkaBrokers}`);

  const kafka = new Kafka({
    clientId: 'topic-creator',
    brokers: kafkaBrokers.split(','),
  });

  const admin: Admin = kafka.admin();

  try {
    await admin.connect();
    console.log('✅ Connected to Kafka');

    // Get list of existing topics
    console.log('📊 Checking existing topics...');
    const existingTopics = await admin.listTopics();

    // Filter out topics that already exist
    const topicsToCreate: ITopicConfig[] = [];

    for (const topicName of topicsToSetup) {
      if (existingTopics.includes(topicName)) {
        console.log(`   ⏭️  Topic "${topicName}" already exists`);
      } else {
        topicsToCreate.push({
          topic: topicName,
          ...TOPIC_CONFIG
        });
        console.log(`   ➕ Will create topic "${topicName}"`);
      }
    }

    // Create missing topics
    if (topicsToCreate.length > 0) {
      console.log(`\n🔨 Creating ${topicsToCreate.length} topics...`);
      await admin.createTopics({
        topics: topicsToCreate,
        waitForLeaders: true
      });
      console.log(`✅ Successfully created ${topicsToCreate.length} Kafka topics`);

      // List created topics
      console.log('\n📋 Created topics:');
      topicsToCreate.forEach(topic => {
        console.log(`   - ${topic.topic}`);
      });
    } else {
      console.log('\n✅ All required topics already exist');
    }

    // Show summary of all topics
    console.log('\n📊 Summary of Kafka topics:');
    for (const topicName of topicsToSetup) {
      const status = existingTopics.includes(topicName) ? '✓' : '✗';
      console.log(`   ${status} ${topicName}`);
    }

  } catch (error) {
    console.error('❌ Failed to create Kafka topics:', error);
    process.exit(1);
  } finally {
    await admin.disconnect();
    console.log('\n👋 Disconnected from Kafka');
  }
}

// Run if executed directly
if (require.main === module) {
  // Check if topics are provided as command line arguments
  const customTopics = process.argv.slice(2);
  const topicsToCreate = customTopics.length > 0 ? customTopics : TOPICS;

  if (customTopics.length > 0) {
    console.log(`\n📝 Creating custom topics: ${customTopics.join(', ')}\n`);
  }

  createKafkaTopics(topicsToCreate)
    .then(() => {
      console.log('\n✨ Topic creation complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Unexpected error:', error);
      process.exit(1);
    });
}

export { createKafkaTopics, TOPICS };

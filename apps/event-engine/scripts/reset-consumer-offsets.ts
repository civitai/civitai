import { Kafka, Admin } from 'kafkajs';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function resetConsumerOffsets() {
  // Get Kafka configuration from environment
  const kafkaBrokers = process.env.KAFKA_BROKERS || 'localhost:9092';
  const consumerGroup = process.env.KAFKA_CONSUMER_GROUP || 'metric-event-watcher';

  console.log('🚀 Initializing Kafka admin client...');
  console.log(`📡 Kafka brokers: ${kafkaBrokers}`);
  console.log(`👥 Consumer group: ${consumerGroup}`);

  const kafka = new Kafka({
    clientId: 'offset-resetter',
    brokers: kafkaBrokers.split(','),
  });

  const admin: Admin = kafka.admin();

  try {
    await admin.connect();
    console.log('✅ Connected to Kafka\n');

    // Get all topics and filter out internal ones
    console.log('📊 Fetching topics...');
    const allTopics = await admin.listTopics();
    const topics = allTopics.filter(t =>
      !t.startsWith('__') &&
      !t.startsWith('debezium-connect-cluster-')
    );
    console.log(`   Found ${topics.length} user topics (${allTopics.length} total)\n`);

    // Get consumer group offsets
    console.log(`📊 Fetching current offsets for consumer group "${consumerGroup}"...`);

    let offsets: Array<{ topic: string; partitions: Array<{ partition: number; offset: string }> }> = [];
    try {
      offsets = await admin.fetchOffsets({ groupId: consumerGroup });
    } catch (error) {
      console.log('⚠️  No offsets found for this consumer group. It may not exist or has no committed offsets.\n');
      return;
    }

    if (offsets.length === 0) {
      console.log('⚠️  No offsets found for this consumer group. It may not exist or has no committed offsets.\n');
      return;
    }

    // Filter to only user topics
    const userOffsets = offsets.filter(o =>
      !o.topic.startsWith('__') &&
      !o.topic.startsWith('debezium-connect-cluster-')
    );

    console.log('📋 Current offsets:');
    for (const { topic, partitions } of userOffsets) {
      for (const { partition, offset } of partitions) {
        console.log(`   ${topic} [${partition}]: ${offset}`);
      }
    }

    // Reset offsets to latest
    console.log('\n⏩ Resetting all offsets to latest...');

    // Get the latest offsets for topics that have committed offsets
    const topicsToReset = userOffsets.map(o => o.topic);

    for (const topic of topicsToReset) {
      try {
        console.log(`   Resetting ${topic}...`);
        const topicOffsets = await admin.fetchTopicOffsets(topic);

        const partitionsToSet = topicOffsets.map(t =>
          t.partitions.map(p => ({
            partition: p.partition,
            offset: p.high, // high watermark = latest
          }))
        ).flat();

        await admin.setOffsets({
          groupId: consumerGroup,
          topic,
          partitions: partitionsToSet,
        });

        console.log(`   ✓ ${topic}`);
      } catch (error: any) {
        console.log(`   ✗ ${topic}: ${error.message}`);
      }
    }

    console.log('\n✅ Successfully reset offsets to latest\n');

    // Verify the new offsets
    console.log('📊 Verifying new offsets...');
    const newOffsets = await admin.fetchOffsets({ groupId: consumerGroup });
    const newUserOffsets = newOffsets.filter(o =>
      !o.topic.startsWith('__') &&
      !o.topic.startsWith('debezium-connect-cluster-')
    );

    console.log('📋 New offsets:');
    for (const { topic, partitions } of newUserOffsets) {
      for (const { partition, offset } of partitions) {
        console.log(`   ${topic} [${partition}]: ${offset}`);
      }
    }

  } catch (error) {
    console.error('❌ Failed to reset consumer offsets:', error);
    process.exit(1);
  } finally {
    await admin.disconnect();
    console.log('\n👋 Disconnected from Kafka');
  }
}

// Run if executed directly
if (require.main === module) {
  resetConsumerOffsets()
    .then(() => {
      console.log('\n✨ Offset reset complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Unexpected error:', error);
      process.exit(1);
    });
}

export { resetConsumerOffsets };

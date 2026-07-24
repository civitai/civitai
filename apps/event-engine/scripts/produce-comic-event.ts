/**
 * Produce a synthetic Debezium envelope to the postgres.ComicProjectEngagement
 * topic so the running watcher processes it like a real CDC event.
 *
 * Prerequisites:
 *   docker-compose up -d            # kafka + debezium
 *   npm run dev                      # in another shell — boots the watcher
 *                                    # (creates the topic via DebeziumManager)
 *
 * Usage:
 *   npx tsx -r tsconfig-paths/register scripts/produce-comic-event.ts <scenario>
 *
 * Scenarios: follow | unfollow | read-first | read-more | unread-all |
 *            switch-to-hide | delete-with-reads
 *
 * Override defaults with env vars:
 *   COMIC_USER_ID=123 COMIC_PROJECT_ID=999 KAFKA_BROKERS=localhost:9092
 */

import { Kafka } from 'kafkajs'

type Op = 'c' | 'u' | 'd'

interface EngagementRow {
  userId: number
  projectId: number
  type: 'None' | 'Notify' | 'Hide'
  readChapters: number[]
  createdAt: number
}

interface DebeziumEnvelope {
  before: EngagementRow | null
  after: EngagementRow | null
  op: Op
  ts_ms: number
  source: Record<string, any>
}

const TOPIC = 'postgres.ComicProjectEngagement'
const userId = parseInt(process.env.COMIC_USER_ID ?? '1001', 10)
const projectId = parseInt(process.env.COMIC_PROJECT_ID ?? '424242', 10)

const row = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  userId,
  projectId,
  type: 'None',
  readChapters: [],
  createdAt: Date.now(),
  ...overrides
})

const envelope = (
  op: Op,
  before: EngagementRow | null,
  after: EngagementRow | null
): DebeziumEnvelope => ({
  before,
  after,
  op,
  ts_ms: Date.now(),
  source: {
    version: 'synthetic',
    connector: 'postgresql',
    name: 'civitai',
    ts_ms: Date.now(),
    snapshot: false,
    db: 'civitai',
    schema: 'public',
    table: 'ComicProjectEngagement',
    txId: 0,
    lsn: 0,
    xmin: null
  }
})

const scenarios: Record<string, () => DebeziumEnvelope> = {
  follow: () =>
    envelope('c', null, row({ type: 'Notify' })),

  unfollow: () =>
    envelope('d', row({ type: 'Notify' }), null),

  'read-first': () =>
    envelope(
      'u',
      row({ type: 'Notify', readChapters: [] }),
      row({ type: 'Notify', readChapters: [9001] })
    ),

  'read-more': () =>
    envelope(
      'u',
      row({ type: 'Notify', readChapters: [9001] }),
      row({ type: 'Notify', readChapters: [9001, 9002, 9003] })
    ),

  'unread-all': () =>
    envelope(
      'u',
      row({ type: 'Notify', readChapters: [9001, 9002] }),
      row({ type: 'Notify', readChapters: [] })
    ),

  'switch-to-hide': () =>
    envelope(
      'u',
      row({ type: 'Notify', readChapters: [9001] }),
      row({ type: 'Hide', readChapters: [9001] })
    ),

  'delete-with-reads': () =>
    envelope(
      'd',
      row({ type: 'Notify', readChapters: [9001, 9002, 9003] }),
      null
    )
}

async function main() {
  const scenario = process.argv[2]
  if (!scenario || !scenarios[scenario]) {
    console.error(`Usage: produce-comic-event.ts <scenario>\n`)
    console.error(`Available scenarios:`)
    for (const name of Object.keys(scenarios)) console.error(`  - ${name}`)
    process.exit(1)
  }

  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
  const kafka = new Kafka({ clientId: 'produce-comic-event', brokers })
  const producer = kafka.producer()

  const payload = scenarios[scenario]()
  const summary = {
    op: payload.op,
    before_type: payload.before?.type ?? null,
    before_reads: payload.before?.readChapters?.length ?? null,
    after_type: payload.after?.type ?? null,
    after_reads: payload.after?.readChapters?.length ?? null,
    userId,
    projectId
  }

  await producer.connect()
  try {
    await producer.send({
      topic: TOPIC,
      messages: [
        {
          key: `${userId}:${projectId}`,
          value: JSON.stringify(payload)
        }
      ]
    })
    console.log(`✓ Sent "${scenario}" to ${TOPIC}`)
    console.log(JSON.stringify(summary, null, 2))
    console.log(
      `\nWatch the running watcher's logs, then verify in ClickHouse:`
    )
    console.log(
      `  SELECT metricType, sum(metricValue) FROM entityMetricEvents`
    )
    console.log(
      `   WHERE entityType='Comic' AND entityId=${projectId} AND userId=${userId}`
    )
    console.log(`   GROUP BY metricType ORDER BY metricType;`)
  } finally {
    await producer.disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import { DebeziumPayload } from '../types/events'

/**
 * Convert a ClickHouse Kafka event to Debezium-like format
 * This allows ClickHouse events to be processed by the same handlers as PostgreSQL events
 */
export function clickhouseToDebeziumFormat(data: any, topic: string): DebeziumPayload {
  return {
    op: 'c', // ClickHouse events are always "create" (new events)
    before: null,
    after: data,
    source: {
      version: '1.0.0',
      connector: 'clickhouse',
      name: 'clickhouse',
      ts_ms: Date.now(),
      snapshot: false,
      db: 'clickhouse',
      schema: 'default',
      table: topic.split('.').pop() || '',
      txId: 0,
      lsn: 0,
      xmin: null
    },
    ts_ms: Date.now()
  }
}
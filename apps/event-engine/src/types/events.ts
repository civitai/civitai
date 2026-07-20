export type Operation = 'create' | 'update' | 'delete'
export type DebeziumOp = 'c' | 'u' | 'd' | 'r'

export interface DebeziumPayload<T = any> {
  before: T | null
  after: T | null
  op: DebeziumOp
  ts_ms: number
  source: {
    version: string
    connector: string
    name: string
    ts_ms: number
    snapshot: string | boolean
    db: string
    schema: string
    table: string
    txId: number
    lsn: number
    xmin: null
  }
}

export interface ParsedEvent<T = any> {
  topic: string
  operation: Operation
  tableName: string
  old: T | null
  current: T | null
  timestamp: Date
}

export interface KafkaOffsetMeta {
  topic: string
  partition: number
  offset: string
}

export interface MetricEvent {
  entityId?: number | null
  entityType: string
  metricType: string
  metricValue: number
  userId?: number | null
  timestamp?: Date
  _kafka?: KafkaOffsetMeta
}

export interface CacheUpdate {
  entityId: number
  entityType: string
  metricType: string
  metricValue: number
  // Originating user of the change. Carried through to the live signal so
  // clients can suppress the echo of their own optimistic update.
  userId?: number | null
}

export interface FeedUpdate {
  entityType: 'Model' | 'Post' | 'Image' | 'Bounty' | 'Article'
  entityId?: number | null
  type: 'update' | 'delete' | 'metricUpdate'
}

export interface IndexUpdate {
  entityType: string
  entityId: number
  type: 'update' | 'delete' | 'metricUpdate'
}

export interface OutboxEvent {
  id: number
  entityType: string
  entityId: number
  event: string
  createdAt: Date
}

export type WorkflowStatus = 'unassigned' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'canceled';

export type WorkflowMessage<TOutputs = any[]> = {
  workflowId: string
  status: WorkflowStatus
  metadata?: Record<string, any>
  outputs: TOutputs
};

/**
 * Helper to create a workflow message sample for testing/debugging
 * Automatically includes workflowId and status fields
 */
export function createWorkflowSample<TOutputs = any[]>(
  faker: any,
  outputsBuilder: () => TOutputs,
  metadata?: Record<string, any>
): WorkflowMessage<TOutputs> {
  return {
    workflowId: faker.string.uuid(),
    status: faker.helpers.arrayElement(['succeeded', 'failed', 'expired', 'canceled'] as WorkflowStatus[]),
    ...(metadata && { metadata }),
    outputs: outputsBuilder()
  };
}

export function mapOperation(op: DebeziumOp): Operation {
  switch (op) {
    case 'c': return 'create'
    case 'u': return 'update'
    case 'd': return 'delete'
    default: throw new Error(`Unknown operation: ${op}`)
  }
}

export function getTableFromTopic(topic: string): string {
  // postgres.UserEngagement -> UserEngagement
  // clickhouse.modelVersionEvent -> modelVersionEvent
  const parts = topic.split('.')
  return parts[parts.length - 1]
}
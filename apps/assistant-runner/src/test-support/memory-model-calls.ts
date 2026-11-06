import type { ModelCallLedger, ModelCallScope } from '../model-calls';

export interface ModelCallRow {
  runId: string;
  userId: string;
  conversationId: string;
  seq: number;
  key: string;
  workflowId: string;
}

/**
 * The model calls' ledger in memory, as `PgModelCalls` keeps it: one row per run and key, the run's
 * own row first, else (with `carriesOn`) the latest an earlier run of the same turn kept. Every save
 * is appended to `order`, so a test can tell it apart in time from the stream being read.
 */
export class MemoryModelCalls implements ModelCallLedger {
  readonly rows: ModelCallRow[] = [];

  constructor(readonly order: string[] = []) {}

  async find(scope: ModelCallScope, key: string): Promise<string | null> {
    const own = this.rows.find((row) => row.runId === scope.runId && row.key === key);
    if (own) return own.workflowId;
    if (!scope.carriesOn) return null;
    const earlier = this.rows.filter(
      (row) =>
        row.key === key &&
        row.userId === scope.userId &&
        row.conversationId === scope.conversationId &&
        row.seq === scope.seq
    );
    return earlier.at(-1)?.workflowId ?? null;
  }

  async save(scope: ModelCallScope, key: string, workflowId: string): Promise<void> {
    const at = this.rows.findIndex((row) => row.runId === scope.runId && row.key === key);
    if (at >= 0) this.rows.splice(at, 1);
    this.rows.push({
      runId: scope.runId,
      userId: scope.userId,
      conversationId: scope.conversationId,
      seq: scope.seq,
      key,
      workflowId,
    });
    this.order.push(`saved ${workflowId}`);
  }
}

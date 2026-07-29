import { Pool } from 'pg'
import { logger } from '@/utils/logger'
import { OutboxRecord } from '@/common/services/outbox'
import { outboxPollerMetrics } from '@/metrics'

// Two-int advisory-lock key for single-active-poller election. Postgres keeps the
// (int, int) and single-bigint advisory-lock key spaces SEPARATE, and the main
// app's only advisory lock is the single-bigint, entity-id-keyed
// `pg_advisory_xact_lock(articleId)` — so a two-int key here can NEVER collide
// with it, regardless of how large entity ids grow. classid is an "event-engine"
// namespace; objid distinguishes this lock within it.
const OUTBOX_POLLER_LOCK_CLASSID = 25974 // 0x6576 ("ev")
const OUTBOX_POLLER_LOCK_OBJID = 1 // the outbox poller

export interface OutboxPollerOptions {
  intervalMs?: number
  graceMs?: number
  batchSize?: number
}

/**
 * Reconciliation poller for the Outbox table.
 *
 * The real-time path (Debezium CDC → outboxHandler) is the primary drainer and
 * clears rows within milliseconds. This poller is the backstop: it claims rows
 * OLDER than a grace window (so it never races the fast path) and runs the same
 * entity handlers, deleting each row only after its handlers succeed
 * (process-then-delete). A row a live event never delivered — created before
 * the connector existed, during a capture gap, or left behind by a failed
 * handler — is drained here instead of accumulating forever.
 *
 * Safe to run on every pod: FOR UPDATE SKIP LOCKED guarantees a row is claimed
 * by at most one worker, and the handlers are idempotent (ClickHouse dedupes
 * via ReplacingMergeTree; feed updates are last-writer-wins).
 */
export class OutboxPoller {
  private interval: NodeJS.Timeout | null = null
  private sweeping = false

  constructor(
    private pool: Pool,
    private processRecord: (record: OutboxRecord) => Promise<void>,
    private intervalMs: number = 5 * 60 * 1000,
    private graceMs: number = 5 * 60 * 1000,
    private batchSize: number = 100,
    private maxAttempts: number = 5,
  ) {}

  start(): void {
    if (this.interval) return
    this.interval = setInterval(() => {
      this.sweep().catch((err) => logger.error({ err }, 'Outbox poller sweep failed'))
    }, this.intervalMs)
    logger.info(
      `Outbox poller started (interval ${this.intervalMs}ms, grace ${this.graceMs}ms, ` +
        `batch ${this.batchSize}, maxAttempts ${this.maxAttempts})`,
    )
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    logger.info('Outbox poller stopped')
  }

  /**
   * Drain aged rows until a non-full batch comes back (or nothing is due).
   * Guards against overlapping sweeps if a slow sweep outruns the interval.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true

    // Single-active-poller election via a Postgres advisory lock: only the pod
    // that holds the lock sweeps. Held on a dedicated connection for the sweep's
    // duration, and self-healing — Postgres drops the lock automatically if this
    // pod dies, so another pod takes over on its next tick. Other pods skip.
    const leader = await this.pool.connect()
    try {
      const lock = await leader.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
        OUTBOX_POLLER_LOCK_CLASSID,
        OUTBOX_POLLER_LOCK_OBJID,
      ])
      if (!lock.rows[0]?.acquired) return // another pod is already sweeping

      try {
        // Cursor pagination by id: every aged row is claimed AT MOST ONCE per
        // sweep. A failed row is left with attempts++, but the cursor has already
        // advanced past it, so it is NOT re-selected until the next sweep. That
        // gives each row one attempt per sweep (≈one per interval) instead of
        // burning the whole retry budget in a single drain.
        let cursor = '0'
        for (;;) {
          const { processed, nextCursor } = await this.sweepBatch(cursor)
          if (processed === 0) break
          cursor = nextCursor as string
        }
        await this.updateParkedGauge()
      } finally {
        // Reached only when we acquired the lock, so this never unlocks a lock
        // we don't own.
        await leader
          .query('SELECT pg_advisory_unlock($1, $2)', [
            OUTBOX_POLLER_LOCK_CLASSID,
            OUTBOX_POLLER_LOCK_OBJID,
          ])
          .catch((err) => logger.warn({ err }, 'Outbox poller: advisory unlock failed'))
      }
    } finally {
      leader.release()
      this.sweeping = false
    }
  }

  /** Re-sample the standing count of parked rows (attempts >= max) for alerting. */
  private async updateParkedGauge(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM "Outbox" WHERE attempts >= $1`,
        [this.maxAttempts],
      )
      outboxPollerMetrics.parked.set(rows[0]?.n ?? 0)
    } catch (err) {
      logger.warn({ err }, 'Outbox poller: failed to update parked gauge')
    }
  }

  private async sweepBatch(cursor: string): Promise<{ processed: number; nextCursor: string | null }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Claim the next page of aged rows by ascending id (id > cursor). FOR
      // UPDATE SKIP LOCKED holds the locks for this transaction so the fast path
      // (which deletes rows) never collides; a SKIP-LOCKED row is simply deferred
      // to the next sweep.
      const { rows } = await client.query(
        `SELECT id, event, "entityType", "entityId", details, "createdAt", attempts
           FROM "Outbox"
          WHERE "createdAt" < now() - ($1::bigint * interval '1 millisecond')
            AND (attempts IS NULL OR attempts < $3)
            AND id > $4::bigint
          ORDER BY id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [this.graceMs, this.batchSize, this.maxAttempts, cursor],
      )

      if (rows.length === 0) {
        await client.query('COMMIT')
        return { processed: 0, nextCursor: null }
      }

      const succeeded: string[] = []
      const failed: string[] = []
      for (const row of rows) {
        const record: OutboxRecord = {
          // int8 columns arrive as strings from node-pg; entity ids are small
          // enough to be safe Numbers.
          id: Number(row.id),
          event: row.event,
          entityType: row.entityType,
          entityId: Number(row.entityId),
          details: row.details ?? null,
          createdAt: row.createdAt,
        }
        try {
          await this.processRecord(record)
          succeeded.push(row.id)
        } catch (err) {
          failed.push(row.id)
          const nextAttempts = (row.attempts ?? 0) + 1
          const parked = nextAttempts >= this.maxAttempts
          if (parked) {
            outboxPollerMetrics.parkedTotal.inc({ entity_type: row.entityType, event: row.event })
          }
          logger.error(
            {
              err,
              outboxId: row.id,
              entityType: row.entityType,
              event: row.event,
              attempts: nextAttempts,
              parked,
            },
            parked
              ? `Outbox poller: row failed ${nextAttempts}× — parking (>= maxAttempts ${this.maxAttempts}); ` +
                  `it will no longer be retried and needs investigation`
              : 'Outbox poller: handler failed; incrementing attempts, leaving row for next sweep',
          )
        }
      }

      if (succeeded.length > 0) {
        await client.query(`DELETE FROM "Outbox" WHERE id = ANY($1::bigint[])`, [succeeded])
        outboxPollerMetrics.drained.inc(succeeded.length)
      }

      // Bump the retry counter on failed rows so a stuck/poison row is visible
      // (queryable), not just logged. NULL is treated as 0.
      if (failed.length > 0) {
        await client.query(
          `UPDATE "Outbox" SET attempts = COALESCE(attempts, 0) + 1 WHERE id = ANY($1::bigint[])`,
          [failed],
        )
      }

      await client.query('COMMIT')
      logger.debug(`Outbox poller drained ${succeeded.length}/${rows.length} aged rows`)
      // Advance past the highest id in this page (rows are ORDER BY id) so the
      // next page starts strictly after it — failed rows here aren't revisited
      // this sweep.
      return { processed: rows.length, nextCursor: rows[rows.length - 1].id as string }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}

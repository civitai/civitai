import { sql, type Kysely } from 'kysely';
import { moderatorDbStatus, storeUnavailableMessage } from '$lib/moderator-db-status';
import { logAxiomError } from '../axiom';
import { getSysRedis } from '../redis';
import { exportState, exportUnsent } from './backlog-import';
import { pauseSends } from './brake';
import { acquireRunLock, releaseRunLock, renewRunLock, runLockKey } from './run-lock';
import { casesDb, noticesOfBatch, type CasesDb } from './cases.db';
import { readPiiLockdown, type PiiLockdown } from './pii-lockdown';
import { defaultSendDeps, sendBatch } from './send-notice';

const LOCKDOWN_MESSAGES: Record<Exclude<PiiLockdown, 'ok'>, string> = {
  open: 'The read-only database role can reach case data (run the read-back in apps/moderator/cases/schema.sql). Case data stays hidden and imports stay off until an infra owner closes it.',
  'no-role':
    'The read-only database role does not exist yet, so the access check cannot pass. Case data stays hidden and imports stay off until it is created and cases/schema.sql is re-run.',
};

/**
 * Null when case data may be shown and written; otherwise why not. Personal data goes into these
 * tables only while the read-only role is shut out of them.
 */
export async function caseDataBlocked(db: CasesDb = casesDb()): Promise<string | null> {
  // The check reads only catalog functions, so it needs no table types.
  const state = await readPiiLockdown(db as unknown as Kysely<unknown>);
  return state === 'ok' ? null : LOCKDOWN_MESSAGES[state];
}

export const CASES_STORE_NAMES = {
  tables: 'The case tables',
  database: 'the moderator database',
  schemaFile: 'apps/moderator/cases/schema.sql',
};

/** The 503 text when the case tables can't be read here, by cause. */
export const casesStoreMessage = (e: unknown) =>
  storeUnavailableMessage(moderatorDbStatus(e), CASES_STORE_NAMES);

export async function listBatches({ db = casesDb() }: { db?: CasesDb } = {}) {
  return db
    .selectFrom('case_record as c')
    .leftJoin('case_notice as n', 'n.case_id', 'c.id')
    .select([
      'c.import_batch_id as batchId',
      sql<number>`count(DISTINCT c.id)::int`.as('cases'),
      sql<number>`count(n.id)::int`.as('notices'),
      sql<number>`count(n.id) FILTER (WHERE n.status = 'sent')::int`.as('sent'),
      sql<Date>`min(c.created_at)`.as('importedAt'),
    ])
    .where('c.import_batch_id', 'is not', null)
    .groupBy('c.import_batch_id')
    .orderBy('importedAt', 'desc')
    .execute();
}

/**
 * Cases filed through the public forms (no import batch), for the queue: minor-flagged first, then by
 * deadline. No party or contact details, so the `cases` grant is enough.
 */
export async function listFiledCases({
  db = casesDb(),
  limit = 200,
}: { db?: CasesDb; limit?: number } = {}) {
  return db
    .selectFrom('case_record as c')
    .innerJoin('process_definition_version as v', 'v.id', 'c.definition_version_id')
    .select([
      'c.public_ref as publicRef',
      sql<string>`v.definition->>'title'`.as('title'),
      'c.state',
      'c.received_at as receivedAt',
      'c.due_at as dueAt',
      'c.minor_flag as minor',
      'c.is_test as isTest',
      sql<
        string | null
      >`(SELECT n.status FROM case_notice n WHERE n.case_id = c.id ORDER BY n.id DESC LIMIT 1)`.as(
        'receipt'
      ),
      sql<boolean>`EXISTS (SELECT 1 FROM case_event e WHERE e.case_id = c.id AND e.type = 'receipt-unsent')`.as(
        'receiptUnsent'
      ),
    ])
    .where('c.import_batch_id', 'is', null)
    .orderBy('c.minor_flag', 'desc')
    .orderBy(sql`c.due_at`, sql`asc nulls last`)
    .orderBy('c.received_at', 'desc')
    .limit(limit)
    .execute();
}

/**
 * Every notice of a batch with its recipient and exact text, for the preview Legal approves. Recipients
 * are personal data: the caller holds `cases.pii`, and each case read is recorded as a `pii_read` event.
 */
export async function batchPreview(
  batchId: string,
  { actorId, db = casesDb() }: { actorId: number; db?: CasesDb }
) {
  const rows = await noticesOfBatch(db, batchId)
    .select([
      'n.id',
      'c.id as caseId',
      'c.public_ref as caseRef',
      'n.notice_id as noticeId',
      'n.recipient_role as recipientRole',
      'n.recipient_address as to',
      'n.subject_snapshot as subject',
      'n.body_snapshot as body',
      'n.status',
      'n.error',
      'n.attempted_at as attemptedAt',
      'n.sent_at as sentAt',
      'n.message_id as messageId',
    ])
    .orderBy('n.id')
    .execute();
  const caseIds = [...new Set(rows.map((r) => r.caseId))];
  if (caseIds.length)
    await db
      .insertInto('case_event')
      .values(
        caseIds.map((caseId) => ({
          case_id: caseId,
          actor_id: actorId,
          type: 'pii_read',
          data: JSON.stringify({ via: 'batch-preview' }),
        }))
      )
      .execute();
  return rows;
}

export { STALE_SENDING_MS } from './cases.db';

/**
 * Start sending a batch in the background and return at once; the page reads progress from the rows.
 * The run holds the batch's run lock, renewed before every claim, and stops if it ever loses it. A run
 * that dies on an error pauses sends.
 */
export async function startBatchSend(
  batchId: string
): Promise<'started' | 'already-running' | 'export-outstanding'> {
  const redis = getSysRedis();
  const token = await acquireRunLock(redis, batchId);
  if (!token) return 'already-running';
  // Checked under the lock the export also takes, so the two can't interleave.
  if ((await exportState(batchId).catch(() => 'outstanding' as const)) === 'outstanding') {
    await releaseRunLock(redis, batchId, token);
    return 'export-outstanding';
  }
  const deps = { ...defaultSendDeps(), holdsLock: () => renewRunLock(redis, batchId, token) };
  void sendBatch(batchId, deps)
    .catch(async (e) => {
      await pauseSends('system', `the send of batch ${batchId} stopped on an error`).catch(
        () => undefined
      );
      await logAxiomError(e, { name: 'cases.sendBatch', batchId });
    })
    .finally(() => releaseRunLock(redis, batchId, token).catch(() => undefined));
  return 'started';
}

const EXPORT_LOCK_TTL_SECONDS = 300;

/**
 * Export the batch's unsent rows for the fallback sender, under the batch's run lock: refused while a
 * send of it runs, and no send can start until it is recorded.
 */
export async function startExport(batchId: string, actorId: number) {
  const redis = getSysRedis();
  const token = await acquireRunLock(redis, batchId, EXPORT_LOCK_TTL_SECONDS);
  if (!token) return 'running' as const;
  const holdsLock = () => renewRunLock(redis, batchId, token, EXPORT_LOCK_TTL_SECONDS);
  // Keep the lock while the export runs; it re-checks before commit in case a renewal was missed.
  const heartbeat = setInterval(() => void holdsLock().catch(() => undefined), 60_000);
  try {
    return await exportUnsent(batchId, { actorId, holdsLock });
  } finally {
    clearInterval(heartbeat);
    await releaseRunLock(redis, batchId, token).catch(() => undefined);
  }
}

export async function isBatchRunning(batchId: string) {
  try {
    return !!(await getSysRedis().get(runLockKey(batchId)));
  } catch {
    return false;
  }
}

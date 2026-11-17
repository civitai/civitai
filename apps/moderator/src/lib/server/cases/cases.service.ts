import { REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { sql, type Kysely } from 'kysely';
import { moderatorDbStatus, storeUnavailableMessage } from '$lib/moderator-db-status';
import { logAxiomError } from '../axiom';
import { getSysRedis } from '../redis';
import { pauseSends } from './brake';
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

/** A row `sending` for longer than this may or may not have gone out; a person checks it. */
export const STALE_SENDING_MS = 10 * 60 * 1000;

const runningKey = (batchId: string) =>
  `${REDIS_SYS_KEYS.APP.CASES_SEND_RUNNING}:${batchId}` as RedisKeyTemplateSys;

/**
 * Start sending a batch in the background (about 85 s for 170 messages at SES's pace) and return at
 * once; the page reads progress from the rows. A lock stops a second run of the same batch from
 * doubling the pace. The claim on each row already stops a double send. A run that dies on an error
 * pauses sends: a person looks before anything else goes out.
 */
export async function startBatchSend(batchId: string): Promise<'started' | 'already-running'> {
  const redis = getSysRedis();
  const got = await redis.set(runningKey(batchId), new Date().toISOString(), { NX: true, EX: 900 });
  if (!got) return 'already-running';
  void sendBatch(batchId, defaultSendDeps())
    .catch(async (e) => {
      await pauseSends('system', `the send of batch ${batchId} stopped on an error`).catch(
        () => undefined
      );
      await logAxiomError(e, { name: 'cases.sendBatch', batchId });
    })
    .finally(() => redis.del(runningKey(batchId)).catch(() => undefined));
  return 'started';
}

export async function isBatchRunning(batchId: string) {
  try {
    return !!(await getSysRedis().get(runningKey(batchId)));
  } catch {
    return false;
  }
}

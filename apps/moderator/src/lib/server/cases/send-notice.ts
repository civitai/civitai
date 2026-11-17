import { createHash } from 'node:crypto';
import {
  NOTICE_MIN_INTERVAL_MS,
  sendEmailStrict,
  withThrottleRetry,
  type Sleep,
} from '@civitai/email';
import { sql } from 'kysely';
import { env } from '$env/dynamic/private';
import { pauseSends, readBrake } from './brake';
import { casesDb, type CasesDb } from './cases.db';

/** How a case notice's address is hashed: trimmed, lower-cased, sha256 hex. */
export function hashAddress(address: string) {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

export const DEFAULT_NOTICE_FROM = 'Civitai DMCA <notices@civitai.com>';
export const DEFAULT_NOTICE_REPLY_TO = 'dmca@civitai.com';
// Above the backlog batch (about 170), so the batch can't trip it by itself.
export const DEFAULT_HOURLY_CEILING = 400;

export type SendOutcome =
  | 'sent'
  | 'failed'
  // Nothing was claimed or sent:
  | 'paused'
  | 'ceiling'
  | 'not-claimable';

export type SendDeps = {
  db: CasesDb;
  send: typeof sendEmailStrict;
  sleep?: Sleep;
  readBrake: typeof readBrake;
  pauseSends: typeof pauseSends;
  /** Told once when the hourly ceiling pauses sends. */
  alert: (message: string) => Promise<unknown>;
  from: string;
  replyTo: string;
  hourlyCeiling: number;
};

export function defaultSendDeps(): SendDeps {
  return {
    db: casesDb(),
    send: sendEmailStrict,
    readBrake,
    pauseSends,
    alert: async (message) => {
      const to = env.MODERATION_ALERT_EMAIL;
      if (!to) return;
      await sendEmailStrict({ to, subject: 'Case notices paused', html: `<p>${message}</p>` });
    },
    from: env.CASES_NOTICE_FROM || DEFAULT_NOTICE_FROM,
    replyTo: env.CASES_NOTICE_REPLY_TO || DEFAULT_NOTICE_REPLY_TO,
    hourlyCeiling: Number(env.CASES_SEND_HOURLY_CEILING) || DEFAULT_HOURLY_CEILING,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A verbatim plain-text body, shown as written. */
const plainToHtml = (text: string) =>
  `<div style="white-space: pre-wrap">${escapeHtml(text)}</div>`;

/** The error to store: a class name and SMTP code, never a message, which can carry an address. */
function errorCode(e: unknown) {
  const err = e as { name?: string; responseCode?: number } | null;
  const name = err?.name && /^[A-Za-z]+$/.test(err.name) ? err.name : 'Error';
  return err?.responseCode ? `${name}:${err.responseCode}` : name;
}

/**
 * Send one case notice, at most once.
 *
 * 1. The brake: paused means nothing is claimed.
 * 2. The hourly ceiling: at or over it, sends are paused (a person has to resume them) and the alert
 *    goes out once.
 * 3. The claim: one UPDATE from `pending`/`failed` to `sending`. Postgres serialises concurrent
 *    UPDATEs of a row and re-checks the WHERE, so exactly one sender gets it back.
 * 4. The send, from the row's own snapshot, retried only on an SES throttle.
 * 5. `sent` with the message id, or `failed` with an error code.
 *
 * A row left `sending` (the process died mid-send) is never retried here: it may have been delivered,
 * so a person checks and resends deliberately.
 */
export async function sendNotice(noticeId: number, deps: SendDeps): Promise<SendOutcome> {
  const brake = await deps.readBrake();
  if (brake.paused) return 'paused';

  const { sent } = await deps.db
    .selectFrom('case_notice')
    .select(sql<number>`count(*)::int`.as('sent'))
    .where('status', '=', 'sent')
    .where('sent_at', '>', sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (sent >= deps.hourlyCeiling) {
    await deps.pauseSends('system', `hourly ceiling of ${deps.hourlyCeiling} reached`);
    await deps.alert(
      `Case notices were paused: ${sent} were sent in the last hour, at the ceiling of ${deps.hourlyCeiling}. Resume them on /cases once checked.`
    );
    return 'ceiling';
  }

  const row = await deps.db
    .updateTable('case_notice')
    .set({ status: 'sending', attempted_at: sql`now()`, error: null })
    .where('id', '=', noticeId)
    .where('status', 'in', ['pending', 'failed'])
    .returning(['id', 'recipient_address', 'address_hash', 'subject_snapshot', 'body_snapshot'])
    .executeTakeFirst();
  if (!row) return 'not-claimable';

  // Erased after retain_until: nothing left to send, and nothing should be.
  if (row.recipient_address === null || row.body_snapshot === null) {
    await deps.db
      .updateTable('case_notice')
      .set({ status: 'failed', error: 'Erased' })
      .where('id', '=', row.id)
      .execute();
    return 'failed';
  }
  const { recipient_address: to, body_snapshot: body } = row;

  if (hashAddress(to) !== row.address_hash) {
    await deps.db
      .updateTable('case_notice')
      .set({ status: 'failed', error: 'AddressHashMismatch' })
      .where('id', '=', row.id)
      .execute();
    return 'failed';
  }

  try {
    const { messageId } = await withThrottleRetry(
      () =>
        deps.send({
          to,
          from: deps.from,
          replyTo: deps.replyTo,
          subject: row.subject_snapshot,
          text: body,
          html: plainToHtml(body),
        }),
      deps.sleep ? { sleep: deps.sleep } : {}
    );
    await deps.db
      .updateTable('case_notice')
      .set({ status: 'sent', message_id: messageId, sent_at: sql`now()` })
      .where('id', '=', row.id)
      .execute();
    return 'sent';
  } catch (e) {
    await deps.db
      .updateTable('case_notice')
      .set({ status: 'failed', error: errorCode(e) })
      .where('id', '=', row.id)
      .execute();
    return 'failed';
  }
}

export type BatchResult = { counts: Record<SendOutcome, number>; stoppedBy?: 'paused' | 'ceiling' };

/**
 * Send every `pending`/`failed` notice of one import batch, oldest first, paced for SES's account-wide
 * rate. Stops at the first send the brake or the ceiling refuses.
 */
export async function sendBatch(
  importBatchId: string,
  deps: SendDeps,
  { minIntervalMs = NOTICE_MIN_INTERVAL_MS }: { minIntervalMs?: number } = {}
): Promise<BatchResult> {
  const sleep: Sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rows = await deps.db
    .selectFrom('case_notice as n')
    .innerJoin('case_record as c', 'c.id', 'n.case_id')
    .select('n.id')
    .where('c.import_batch_id', '=', importBatchId)
    .where('n.status', 'in', ['pending', 'failed'])
    .orderBy('n.id')
    .execute();

  const counts: BatchResult['counts'] = {
    sent: 0,
    failed: 0,
    paused: 0,
    ceiling: 0,
    'not-claimable': 0,
  };
  for (const [i, { id }] of rows.entries()) {
    if (i > 0) await sleep(minIntervalMs);
    const outcome = await sendNotice(id, deps);
    counts[outcome]++;
    if (outcome === 'paused' || outcome === 'ceiling') return { counts, stoppedBy: outcome };
  }
  return { counts };
}

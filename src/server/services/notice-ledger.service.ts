import { logToAxiom } from '~/server/logging/client';
import type { REDIS_SYS_KEYS } from '~/server/redis/client';
import { sysRedis } from '~/server/redis/client';
import { chunkIds } from '~/utils/array-helpers';

export type NoticeLedgerKey = (typeof REDIS_SYS_KEYS.NOTICES)[keyof typeof REDIS_SYS_KEYS.NOTICES];

const READ_CHUNK = 500;

/**
 * The gap between two bulk-notice sends. The SES sending rate is account-wide, so a bulk run
 * that goes faster gets throttled and takes the rest of the site's email down with it.
 */
export const NOTICE_MIN_INTERVAL_MS = 500;
/** Waits before each retry of a throttled send. */
export const THROTTLE_RETRY_DELAYS_MS = [2_000, 5_000];

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** SES answers an over-rate send with SMTP 454 "Throttling failure: Maximum sending rate exceeded". */
export function isThrottlingError(e: unknown) {
  const err = e as { responseCode?: number; message?: string } | null;
  return err?.responseCode === 454 || /throttling/i.test(err?.message ?? '');
}

/**
 * Runs `fn`, retrying it after each delay while it fails with an SES throttle. Wrap only the email
 * step, so a retry can't repeat whatever the send did before it.
 */
export async function withThrottleRetry<T>(
  fn: () => Promise<T>,
  { delaysMs = THROTTLE_RETRY_DELAYS_MS, sleep = realSleep } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length || !isThrottlingError(e)) throw e;
      await sleep(delaysMs[attempt]);
    }
  }
}

/** Which of `ids` the ledger (a hash of userId → sent-at) already records. */
export async function getNoticeSentIds(ledgerKey: NoticeLedgerKey, ids: number[]) {
  const sent = new Set<number>();
  for (const chunk of chunkIds(ids, READ_CHUNK)) {
    const values = await sysRedis.hmGet(ledgerKey, chunk.map(String));
    values.forEach((value, j) => {
      if (value) sent.add(chunk[j]);
    });
  }
  return sent;
}

/** How many users the ledger records as sent. */
export async function countNoticeSent(ledgerKey: NoticeLedgerKey) {
  return sysRedis.hLen(ledgerKey);
}

/**
 * Sends a one-off notice to up to `count` not-yet-sent recipients, `batchSize` at a time, starting
 * sends at least `minIntervalMs` apart. Each recipient is claimed with `hSetNX` before `send` runs
 * (the `pending` read alone doesn't stop a concurrent run), so no run sends twice; a failed send is
 * un-claimed so the next run retries it, except `stuckUserIds`, whose un-claim also failed.
 */
export async function sendLedgeredNotice<R extends { id: number }>({
  ledgerKey,
  expiresAt,
  logName,
  pending,
  count,
  batchSize,
  minIntervalMs = NOTICE_MIN_INTERVAL_MS,
  sleep = realSleep,
  send,
}: {
  ledgerKey: NoticeLedgerKey;
  expiresAt: Date;
  logName: string;
  /** Recipients not already in the ledger. */
  pending: R[];
  count: number;
  batchSize: number;
  minIntervalMs?: number;
  sleep?: Sleep;
  send: (recipient: R) => Promise<void>;
}) {
  const key = ledgerKey;
  const batch = pending.slice(0, count);
  let sent = 0;
  let skipped = 0;
  const failedUserIds: number[] = [];
  const stuckUserIds: number[] = [];
  // Each send reserves the next start slot, so parallel sends in a batch are spaced too.
  let nextStart = 0;
  const pace = async () => {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + minIntervalMs;
    if (start > now) await sleep(start - now);
  };
  for (let i = 0; i < batch.length; i += batchSize) {
    await Promise.all(
      batch.slice(i, i + batchSize).map(async (recipient) => {
        const claimed = await sysRedis.hSetNX(key, String(recipient.id), new Date().toISOString());
        if (!claimed) {
          skipped++;
          return;
        }
        try {
          await pace();
          await send(recipient);
          sent++;
        } catch (e) {
          // A transport rejection's message carries the recipient's address: log only its class.
          logToAxiom({
            type: 'error',
            name: logName,
            message: 'send failed',
            details: { userId: recipient.id, error: (e as Error).name },
          }).catch(() => undefined);
          failedUserIds.push(recipient.id);
          await sysRedis
            .hDel(key, String(recipient.id))
            .catch(() => stuckUserIds.push(recipient.id));
        }
      })
    );
  }
  if (sent) await sysRedis.expireAt(key, expiresAt);
  return {
    sent,
    skipped,
    failed: failedUserIds.length,
    failedUserIds,
    // Failed AND still recorded as sent, so later runs skip them until they are unmarked.
    stuckUserIds,
    remaining: pending.length - sent - skipped,
  };
}

import { logToAxiom } from '~/server/logging/client';
import type { REDIS_SYS_KEYS } from '~/server/redis/client';
import { sysRedis } from '~/server/redis/client';
import { chunkIds } from '~/utils/array-helpers';

export type NoticeLedgerKey = (typeof REDIS_SYS_KEYS.NOTICES)[keyof typeof REDIS_SYS_KEYS.NOTICES];

const READ_CHUNK = 500;

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

/**
 * Sends a one-off notice to up to `count` not-yet-sent recipients, `batchSize` at a time. Each
 * recipient is claimed with `hSetNX` before `send` runs (the `pending` read alone doesn't stop a
 * concurrent run), so no run sends twice; a failed send is un-claimed so the next run retries it, except `stuckUserIds`,
 * whose un-claim also failed.
 */
export async function sendLedgeredNotice<R extends { id: number }>({
  ledgerKey,
  expiresAt,
  logName,
  pending,
  count,
  batchSize,
  send,
}: {
  ledgerKey: NoticeLedgerKey;
  expiresAt: Date;
  logName: string;
  /** Recipients not already in the ledger. */
  pending: R[];
  count: number;
  batchSize: number;
  send: (recipient: R) => Promise<void>;
}) {
  const key = ledgerKey;
  const batch = pending.slice(0, count);
  let sent = 0;
  let skipped = 0;
  const failedUserIds: number[] = [];
  const stuckUserIds: number[] = [];
  for (let i = 0; i < batch.length; i += batchSize) {
    await Promise.all(
      batch.slice(i, i + batchSize).map(async (recipient) => {
        const claimed = await sysRedis.hSetNX(key, String(recipient.id), new Date().toISOString());
        if (!claimed) {
          skipped++;
          return;
        }
        try {
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

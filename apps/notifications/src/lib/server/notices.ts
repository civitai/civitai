// System notices: one free-text on-site notice to a list of users, with a dry run, per-user dedupe,
// and an audit row per send (NoticeSend / NoticeSendCall, containers/notification-db/docker-init/02).

import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { chunk } from 'lodash-es';
import {
  NotificationCategory,
  renderNoticeMessage,
  type CreateNotificationRow,
  type NoticeBucket,
  type SendSystemNoticesParsed,
  type SendSystemNoticesResult,
  type SystemNoticeSendRecord,
  type SystemNoticeType,
} from '@civitai/notifications';
import { mainDbRead, notifDbWrite } from './clients/db';
import { logAxiomError } from './clients/axiom';
import { createNotificationsBulk } from './operations';
import { noticesChunkPauseMs, noticesDailyRecipientCeiling } from '../../env';

const categoryByType: Record<SystemNoticeType, NotificationCategory> = {
  'system-message': NotificationCategory.Other,
  'system-announcement': NotificationCategory.System,
};

// Longer than the slowest call (50,000 per-user rows, paced); only reached if a call dies holding it.
const LEASE_TTL = '15 minutes';
const GLOBAL_SEND_LEASE = 'global-send';
const WRITE_CHUNK = 1000;
const DROPPED_ID_CAP = 1000;
const SAMPLE_COUNT = 5;

export class NoticeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'NoticeError';
  }
}

export type NoticeCaller = { credential: 'notices-token'; actorUserId?: number };

const dedupeKeyFor = (sendId: string) => `notice:${sendId}`;
const userKeyFor = (sendId: string, userId: number) => `notice:${sendId}:${userId}`;

function contentHash(input: Pick<SendSystemNoticesParsed, 'type' | 'message' | 'url'>) {
  return createHash('sha256')
    .update(JSON.stringify([input.type, input.message, input.url ?? null]))
    .digest('hex');
}

// Every notif query goes through the write pool (the primary) as a standalone statement, so nothing
// here depends on keeping one server connection, which a transaction-mode pooler does not give.
async function notifRows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await notifDbWrite().cancellableQuery<T>(sql, params)).result();
}

async function mainRows<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  return (await mainDbRead().cancellableQuery<T>(sql, params)).result();
}

async function acquireLease(name: string, holder: string): Promise<boolean> {
  const taken = await notifRows<{ name: string }>(
    `INSERT INTO "NoticeSendLease" (name, holder, "lockedUntil")
     VALUES ($1, $2, now() + interval '${LEASE_TTL}')
     ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, "lockedUntil" = excluded."lockedUntil"
       WHERE "NoticeSendLease"."lockedUntil" < now()
     RETURNING name`,
    [name, holder]
  );
  return taken.length === 1;
}

async function releaseLease(name: string, holder: string) {
  await notifRows(`DELETE FROM "NoticeSendLease" WHERE name = $1 AND holder = $2`, [name, holder]);
}

type Buckets = Record<NoticeBucket, number[]>;

async function bucketRecipients(
  input: SendSystemNoticesParsed,
  userIds: number[]
): Promise<Buckets> {
  const users = await mainRows<{ id: number; inactive: boolean }>(
    `SELECT id, ("bannedAt" IS NOT NULL OR "deletedAt" IS NOT NULL) AS inactive
       FROM "User" WHERE id = ANY($1::int[])`,
    [userIds]
  );
  const inactiveById = new Map(users.map((u) => [u.id, u.inactive]));

  // Same opt-out query as create.ts.
  const optedOut = new Set(
    (
      await mainRows<{ userId: number }>(
        `SELECT "userId" FROM "UserNotificationSettings" WHERE "userId" = ANY($1::int[]) AND "type" = $2`,
        [userIds, input.type]
      )
    ).map((r) => r.userId)
  );

  // On the primary, so replica lag cannot hide an earlier call's rows.
  const dedupeKey = dedupeKeyFor(input.sendId);
  const sent = new Set(
    (
      await notifRows<{ userId: number }>(
        `SELECT "userId" FROM "UserNotification" WHERE "dedupeKey" = $1 AND "userId" = ANY($2::int[])
         UNION
         SELECT unnest(users) FROM "PendingNotification" WHERE "dedupeKey" = $1
         UNION
         SELECT split_part(key, ':', 3)::int FROM "Notification" WHERE key = ANY($3::text[])`,
        [
          dedupeKey,
          userIds,
          input.recipients ? userIds.map((id) => userKeyFor(input.sendId, id)) : [],
        ]
      )
    ).map((r) => Number(r.userId))
  );

  const buckets: Buckets = {
    queued: [],
    optedOut: [],
    unknownUser: [],
    inactiveUser: [],
    alreadySent: [],
  };
  for (const id of userIds) {
    const inactive = inactiveById.get(id);
    if (inactive === undefined) buckets.unknownUser.push(id);
    else if (inactive && !input.includeInactive) buckets.inactiveUser.push(id);
    else if (optedOut.has(id)) buckets.optedOut.push(id);
    else if (sent.has(id)) buckets.alreadySent.push(id);
    else buckets.queued.push(id);
  }
  return buckets;
}

function buildRows(input: SendSystemNoticesParsed, queued: number[]): CreateNotificationRow[][] {
  const base = {
    type: input.type,
    category: categoryByType[input.type],
    dedupeKey: dedupeKeyFor(input.sendId),
  };
  const url = input.url ? { url: input.url } : {};
  if (input.recipients) {
    const paramsById = new Map(input.recipients.map((r) => [r.userId, r.params]));
    const perUser = queued.map((userId) => ({
      ...base,
      key: userKeyFor(input.sendId, userId),
      users: [userId],
      details: { message: renderNoticeMessage(input.message, paramsById.get(userId)), ...url },
    }));
    return chunk(perUser, WRITE_CHUNK);
  }
  // One shared key: each batch must be its own bulk call, since two rows with one key in a single
  // upsert would collide with each other.
  return chunk(queued, WRITE_CHUNK).map((users) => [
    {
      ...base,
      key: dedupeKeyFor(input.sendId),
      users,
      details: { message: input.message, ...url },
    },
  ]);
}

function samplesFor(input: SendSystemNoticesParsed, queued: number[]) {
  const paramsById = new Map(input.recipients?.map((r) => [r.userId, r.params]));
  return queued.slice(0, SAMPLE_COUNT).map((userId) => ({
    userId,
    message: renderNoticeMessage(input.message, paramsById.get(userId)),
    ...(input.url ? { url: input.url } : {}),
  }));
}

// NoticeSend keeps its first caller; each call's caller is on its NoticeSendCall row.
async function ensureSendRecord(
  input: SendSystemNoticesParsed,
  hash: string,
  caller: NoticeCaller
) {
  await notifRows(
    `INSERT INTO "NoticeSend"
       ("sendId", type, message, url, "contentHash", "sentBy", "actorUserId", reason, credential)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ("sendId") DO NOTHING`,
    [
      input.sendId,
      input.type,
      input.message,
      input.url ?? null,
      hash,
      input.sentBy,
      caller.actorUserId ?? null,
      input.reason,
      caller.credential,
    ]
  );
  const [existing] = await notifRows<{ contentHash: string }>(
    `SELECT "contentHash" FROM "NoticeSend" WHERE "sendId" = $1`,
    [input.sendId]
  );
  if (existing?.contentHash !== hash) {
    throw new NoticeError(
      409,
      'sendId was already used with a different type, message or url; pick a new sendId'
    );
  }
}

async function recordCall(
  input: SendSystemNoticesParsed,
  caller: NoticeCaller,
  requested: number,
  queued: number
) {
  await notifRows(
    `INSERT INTO "NoticeSendCall"
       ("sendId", mode, requested, queued, "sentBy", reason, credential, "actorUserId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.sendId,
      input.mode,
      requested,
      queued,
      input.sentBy,
      input.reason,
      caller.credential,
      caller.actorUserId ?? null,
    ]
  );
}

// Counts sum real sends only; a dry run bumps dryRuns and nothing else.
async function addToSendTotals(
  input: SendSystemNoticesParsed,
  requested: number,
  counts: Record<NoticeBucket, number>
) {
  const isSend = input.mode === 'send';
  const n = (value: number) => (isSend ? value : 0);
  await notifRows(
    `UPDATE "NoticeSend" SET
       requested = requested + $2, queued = queued + $3, "optedOut" = "optedOut" + $4,
       "unknownUser" = "unknownUser" + $5, "inactiveUser" = "inactiveUser" + $6,
       "alreadySent" = "alreadySent" + $7,
       "dryRuns" = "dryRuns" + $8, sends = sends + $9, "lastAt" = now()
     WHERE "sendId" = $1`,
    [
      input.sendId,
      n(requested),
      n(counts.queued),
      n(counts.optedOut),
      n(counts.unknownUser),
      n(counts.inactiveUser),
      n(counts.alreadySent),
      isSend ? 0 : 1,
      n(1),
    ]
  );
}

async function remainingAllowance(): Promise<number> {
  const [row] = await notifRows<{ used: number }>(
    `SELECT COALESCE(SUM(queued), 0)::int AS used FROM "NoticeSendCall"
      WHERE mode = 'send' AND "createdAt" > now() - interval '24 hours'`
  );
  return Math.max(0, noticesDailyRecipientCeiling - (row?.used ?? 0));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendSystemNotices(
  input: SendSystemNoticesParsed,
  caller: NoticeCaller
): Promise<SendSystemNoticesResult> {
  const userIds = input.userIds ?? input.recipients!.map((r) => r.userId);
  const isSend = input.mode === 'send';
  const holder = randomUUID();
  const held: string[] = [];

  try {
    const sendLease = `send:${input.sendId}`;
    if (!(await acquireLease(sendLease, holder)))
      throw new NoticeError(409, 'Another call for this sendId is in progress');
    held.push(sendLease);
    if (isSend) {
      if (!(await acquireLease(GLOBAL_SEND_LEASE, holder)))
        throw new NoticeError(409, 'Another notice send is in progress; retry shortly');
      held.push(GLOBAL_SEND_LEASE);
    }

    await ensureSendRecord(input, contentHash(input), caller);
    const buckets = await bucketRecipients(input, userIds);
    const counts = countsOf(buckets);

    if (isSend) {
      const remaining = await remainingAllowance();
      if (counts.queued > remaining) {
        throw new NoticeError(
          429,
          `Rolling 24h notice ceiling (${noticesDailyRecipientCeiling} recipients) would be exceeded`,
          { remaining, wouldQueue: counts.queued }
        );
      }
    }

    // Recorded before the writes, at the full planned count: a send that fails part-way still counts
    // in full toward the ceiling.
    await recordCall(input, caller, userIds.length, counts.queued);

    if (isSend) {
      let written = 0;
      const batches = buildRows(input, buckets.queued);
      try {
        for (const [i, batch] of batches.entries()) {
          if (i > 0 && noticesChunkPauseMs) await pause(noticesChunkPauseMs);
          await createNotificationsBulk(batch);
          written += batch.reduce((total, row) => total + row.users.length, 0);
        }
      } catch (err) {
        throw new NoticeError(
          500,
          `Write failed with at least ${written} recipients queued; re-run the same call to finish`,
          { written },
          { cause: err }
        );
      }
    }

    await addToSendTotals(input, userIds.length, counts);

    const dropped: SendSystemNoticesResult['dropped'] = {};
    for (const bucket of ['optedOut', 'unknownUser', 'inactiveUser', 'alreadySent'] as const) {
      if (buckets[bucket].length) dropped[bucket] = buckets[bucket].slice(0, DROPPED_ID_CAP);
    }
    return {
      sendId: input.sendId,
      mode: input.mode,
      requested: userIds.length,
      counts,
      samples: samplesFor(input, buckets.queued),
      dropped,
    };
  } finally {
    // A lease that fails to release here expires after LEASE_TTL.
    for (const name of held.reverse()) await releaseLease(name, holder).catch(logAxiomError);
  }
}

function countsOf(buckets: Buckets): Record<NoticeBucket, number> {
  return {
    queued: buckets.queued.length,
    optedOut: buckets.optedOut.length,
    unknownUser: buckets.unknownUser.length,
    inactiveUser: buckets.inactiveUser.length,
    alreadySent: buckets.alreadySent.length,
  };
}

export async function getSystemNoticeSend(sendId: string): Promise<SystemNoticeSendRecord | null> {
  const [row] = await notifRows<SystemNoticeSendRecord>(
    `SELECT * FROM "NoticeSend" WHERE "sendId" = $1`,
    [sendId]
  );
  return row ?? null;
}

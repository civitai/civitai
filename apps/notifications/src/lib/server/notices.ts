// System notices: one free-text on-site notice to a list of users, with a dry run, per-user dedupe,
// and an audit row per send (NoticeSend / NoticeSendCall, containers/notification-db/docker-init/02).

import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
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
import { createNotificationsBulk } from './operations';
import { noticesChunkPauseMs, noticesDailyRecipientCeiling } from '../../env';

const categoryByType: Record<SystemNoticeType, NotificationCategory> = {
  'system-message': NotificationCategory.Other,
  'system-announcement': NotificationCategory.System,
};

// Two-int advisory keys, namespaced so they cannot collide with any other lock on the notif DB.
const SEND_ID_LOCK_NS = 74_201;
const GLOBAL_SEND_LOCK: [number, number] = [74_202, 0];
const WRITE_CHUNK = 1000;
const DROPPED_ID_CAP = 1000;
const SAMPLE_COUNT = 5;

export class NoticeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'NoticeError';
  }
}

export type NoticeCredential = 'notices-token';

const dedupeKeyFor = (sendId: string) => `notice:${sendId}`;
const userKeyFor = (sendId: string, userId: number) => `notice:${sendId}:${userId}`;

function contentHash(input: Pick<SendSystemNoticesParsed, 'type' | 'message' | 'url'>) {
  return createHash('sha256')
    .update(JSON.stringify([input.type, input.message, input.url ?? null]))
    .digest('hex');
}

async function rows<T>(client: PoolClient, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}

async function tryLock(client: PoolClient, key: [number, string | number]) {
  const sql =
    typeof key[1] === 'string'
      ? `SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked`
      : `SELECT pg_try_advisory_lock($1, $2) AS locked`;
  const [row] = await rows<{ locked: boolean }>(client, sql, key);
  return row?.locked === true;
}

async function unlock(client: PoolClient, key: [number, string | number]) {
  const sql =
    typeof key[1] === 'string'
      ? `SELECT pg_advisory_unlock($1, hashtext($2))`
      : `SELECT pg_advisory_unlock($1, $2)`;
  await client.query(sql, key);
}

async function mainRows<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  return (await mainDbRead().cancellableQuery<T>(sql, params)).result();
}

type Buckets = Record<NoticeBucket, number[]>;

async function bucketRecipients(
  client: PoolClient,
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

  // Read on the primary (the locked client), so replica lag cannot hide an earlier call's rows. A
  // per-user Notification with no UserNotification yet is the worker mid-drain: already delivered.
  const dedupeKey = dedupeKeyFor(input.sendId);
  const sent = new Set(
    (
      await rows<{ userId: number }>(
        client,
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

async function upsertAudit(
  client: PoolClient,
  input: SendSystemNoticesParsed,
  hash: string,
  credential: NoticeCredential
) {
  const [existing] = await rows<{ contentHash: string }>(
    client,
    `SELECT "contentHash" FROM "NoticeSend" WHERE "sendId" = $1`,
    [input.sendId]
  );
  if (existing && existing.contentHash !== hash) {
    throw new NoticeError(
      409,
      'sendId was already used with a different type, message or url; pick a new sendId'
    );
  }
  if (!existing) {
    await client.query(
      `INSERT INTO "NoticeSend" ("sendId", type, message, url, "contentHash", "sentBy", reason, credential)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.sendId,
        input.type,
        input.message,
        input.url ?? null,
        hash,
        input.sentBy,
        input.reason,
        credential,
      ]
    );
  }
}

async function recordCall(
  client: PoolClient,
  input: SendSystemNoticesParsed,
  requested: number,
  counts: Record<NoticeBucket, number>
) {
  const isSend = input.mode === 'send';
  await client.query(
    `INSERT INTO "NoticeSendCall" ("sendId", mode, requested, queued) VALUES ($1, $2, $3, $4)`,
    [input.sendId, input.mode, requested, counts.queued]
  );
  // Counts sum real sends only; a dry run bumps dryRuns and nothing else.
  await client.query(
    `UPDATE "NoticeSend" SET
       requested = requested + $2, queued = queued + $3, "optedOut" = "optedOut" + $4,
       "unknownUser" = "unknownUser" + $5, "inactiveUser" = "inactiveUser" + $6,
       "alreadySent" = "alreadySent" + $7,
       "dryRuns" = "dryRuns" + $8, sends = sends + $9, "sentBy" = $10, reason = $11, "lastAt" = now()
     WHERE "sendId" = $1`,
    [
      input.sendId,
      isSend ? requested : 0,
      isSend ? counts.queued : 0,
      isSend ? counts.optedOut : 0,
      isSend ? counts.unknownUser : 0,
      isSend ? counts.inactiveUser : 0,
      isSend ? counts.alreadySent : 0,
      isSend ? 0 : 1,
      isSend ? 1 : 0,
      input.sentBy,
      input.reason,
    ]
  );
}

async function remainingAllowance(client: PoolClient): Promise<number> {
  const [row] = await rows<{ used: number }>(
    client,
    `SELECT COALESCE(SUM(queued), 0)::int AS used FROM "NoticeSendCall"
      WHERE mode = 'send' AND "createdAt" > now() - interval '24 hours'`
  );
  return Math.max(0, noticesDailyRecipientCeiling - (row?.used ?? 0));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendSystemNotices(
  input: SendSystemNoticesParsed,
  credential: NoticeCredential
): Promise<SendSystemNoticesResult> {
  const userIds = input.userIds ?? input.recipients!.map((r) => r.userId);
  const hash = contentHash(input);
  const isSend = input.mode === 'send';

  const client = (await notifDbWrite().connect()) as PoolClient;
  const held: Array<[number, string | number]> = [];
  try {
    const sendLock: [number, string] = [SEND_ID_LOCK_NS, input.sendId];
    if (!(await tryLock(client, sendLock)))
      throw new NoticeError(409, 'Another call for this sendId is in progress');
    held.push(sendLock);
    if (isSend) {
      if (!(await tryLock(client, GLOBAL_SEND_LOCK)))
        throw new NoticeError(409, 'Another notice send is in progress; retry shortly');
      held.push(GLOBAL_SEND_LOCK);
    }

    await upsertAudit(client, input, hash, credential);
    const buckets = await bucketRecipients(client, input, userIds);

    if (isSend) {
      const remaining = await remainingAllowance(client);
      if (buckets.queued.length > remaining) {
        throw new NoticeError(
          429,
          `Rolling 24h notice ceiling (${noticesDailyRecipientCeiling} recipients) would be exceeded`,
          { remaining, wouldQueue: buckets.queued.length }
        );
      }
    }

    let written = 0;
    if (isSend) {
      const batches = buildRows(input, buckets.queued);
      try {
        for (const [i, batch] of batches.entries()) {
          if (i > 0 && noticesChunkPauseMs) await pause(noticesChunkPauseMs);
          await createNotificationsBulk(batch);
          written += batch.reduce((n, r) => n + r.users.length, 0);
        }
      } catch (err) {
        const partial = { ...countsOf(buckets), queued: written };
        await recordCall(client, input, userIds.length, partial).catch(() => undefined);
        throw new NoticeError(
          500,
          `Write failed after ${written} recipients: ${(err as Error).message}`,
          {
            written,
          }
        );
      }
    }

    const counts = countsOf(buckets);
    await recordCall(client, input, userIds.length, counts);

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
    let unlockFailed = false;
    for (const key of held.reverse()) {
      await unlock(client, key).catch(() => {
        unlockFailed = true;
      });
    }
    // Session advisory locks outlive the checkout: a connection we could not unlock is destroyed, not
    // returned to the pool still holding them.
    client.release(unlockFailed);
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
  const [row] = await (
    await notifDbWrite().cancellableQuery<SystemNoticeSendRecord>(
      `SELECT * FROM "NoticeSend" WHERE "sendId" = $1`,
      [sendId]
    )
  ).result();
  return row ?? null;
}

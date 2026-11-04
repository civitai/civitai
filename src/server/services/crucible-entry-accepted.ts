import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { visibleEntryImageSql } from '~/server/services/crucible-entry-sql';
import { getCrucibleThemeReviews } from '~/server/services/crucible-theme-review-config';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

export type CrucibleEntryRef = { entryId: number; crucibleId: number; userId: number };

/**
 * Something that acts once a crucible entry is accepted: it has passed the crucible's checks and,
 * when the crucible has an AI theme review, that review. `accept` can be called more than once for
 * one entry (a failed run is retried) and `revoke` for an entry never accepted, so both must be
 * idempotent. Only entries of crucibles carrying one of `eventTags` reach a subscriber.
 */
export type CrucibleEntrySubscriber = {
  name: string;
  eventTags: readonly string[];
  accept: (entry: CrucibleEntryRef & { acceptedAt: Date }) => Promise<void>;
  revoke: (entry: CrucibleEntryRef) => Promise<void>;
};

export const CRUCIBLE_ENTRY_SUBSCRIBERS: readonly CrucibleEntrySubscriber[] = [];

const ACCEPTED_TTL_SECONDS = 90 * 24 * 60 * 60;

const acceptedKey = (crucibleId: number) =>
  `${REDIS_SYS_KEYS.SYSTEM.CRUCIBLE_ENTRY_ACCEPTED}:${crucibleId}` as const;

const subscribedTags = (subscribers: readonly CrucibleEntrySubscriber[]) => [
  ...new Set(subscribers.flatMap((s) => s.eventTags)),
];

async function crucibleTags(crucibleId: number) {
  const crucible = await dbRead.crucible.findUnique({
    where: { id: crucibleId },
    select: { eventTags: true },
  });
  return crucible?.eventTags ?? [];
}

const interested = (subscribers: readonly CrucibleEntrySubscriber[], tags: string[]) =>
  subscribers.filter((s) => s.eventTags.some((tag) => tags.includes(tag)));

/**
 * Accepts an entry: every interested subscriber runs, and only once all of them succeed is the
 * entry recorded as accepted. A failure throws and leaves it unrecorded for the next sweep.
 * Returns false when it was already accepted.
 */
export async function acceptCrucibleEntry(
  entry: CrucibleEntryRef,
  subscribers: readonly CrucibleEntrySubscriber[] = CRUCIBLE_ENTRY_SUBSCRIBERS
) {
  const key = acceptedKey(entry.crucibleId);
  if (await sysRedis.hExists(key, String(entry.entryId))) return false;

  const acceptedAt = new Date();
  const targets = interested(subscribers, await crucibleTags(entry.crucibleId));
  for (const subscriber of targets) await subscriber.accept({ ...entry, acceptedAt });

  await sysRedis.hSet(key, String(entry.entryId), acceptedAt.toISOString());
  await sysRedis.expire(key, ACCEPTED_TTL_SECONDS);
  logToAxiom({
    type: 'info',
    name: 'crucible-entry-accepted',
    ...entry,
    subscribers: targets.map((s) => s.name),
  });
  return true;
}

/**
 * Takes an entry back from every subscriber once it has left the crucible. Never throws: the
 * removal it follows has already happened, so a subscriber's failure is logged for a person.
 */
export async function revokeCrucibleEntry(
  entry: CrucibleEntryRef,
  subscribers: readonly CrucibleEntrySubscriber[] = CRUCIBLE_ENTRY_SUBSCRIBERS
) {
  try {
    await sysRedis.hDel(acceptedKey(entry.crucibleId), String(entry.entryId));
    const targets = interested(subscribers, await crucibleTags(entry.crucibleId));
    for (const subscriber of targets) {
      try {
        await subscriber.revoke(entry);
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'crucible-entry-revoke-failed',
          ...entry,
          subscriber: subscriber.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'crucible-entry-revoke-failed',
      ...entry,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The judgeable entries of running crucibles tagged with one of `eventTags`, oldest first, skipping
 * `excludeCrucibleIds`.
 */
export const getJudgeableTaggedEntries = (eventTags: string[], excludeCrucibleIds: number[]) =>
  dbRead.$queryRaw<CrucibleEntryRef[]>`
    SELECT ce.id AS "entryId", ce."crucibleId", ce."userId"
    FROM "Crucible" c
    JOIN "CrucibleEntry" ce ON ce."crucibleId" = c.id
    JOIN "Image" i ON i.id = ce."imageId"
    WHERE c."eventTags" && ${eventTags}::text[]
      AND c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      AND c."endAt" > now()
      ${
        excludeCrucibleIds.length
          ? Prisma.sql`AND c.id <> ALL(${excludeCrucibleIds}::int[])`
          : Prisma.empty
      }
      AND ${visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, 0)}
    ORDER BY ce.id
  `;

/**
 * Accepts the entries no AI theme review holds back: in a crucible without one, an entry is accepted
 * once judges can see it. Crucibles with a review are accepted by the review alone.
 */
export async function sweepAcceptedCrucibleEntries(
  subscribers: readonly CrucibleEntrySubscriber[] = CRUCIBLE_ENTRY_SUBSCRIBERS
) {
  const result = { accepted: 0, failed: 0, skipped: false };
  const tags = subscribedTags(subscribers);
  if (!tags.length) return result;

  const reviews = await getCrucibleThemeReviews();
  if (!reviews) return { ...result, skipped: true };

  const entries = await getJudgeableTaggedEntries(
    tags,
    reviews.map((r) => r.crucibleId)
  );
  const byCrucible = new Map<number, CrucibleEntryRef[]>();
  for (const entry of entries) {
    const list = byCrucible.get(entry.crucibleId) ?? [];
    list.push(entry);
    byCrucible.set(entry.crucibleId, list);
  }

  for (const [crucibleId, list] of byCrucible) {
    const accepted = await sysRedis.hGetAll(acceptedKey(crucibleId));
    for (const entry of list) {
      if (String(entry.entryId) in accepted) continue;
      try {
        if (await acceptCrucibleEntry(entry, subscribers)) result.accepted++;
      } catch (error) {
        result.failed++;
        logToAxiom({
          type: 'error',
          name: 'crucible-entry-accept-failed',
          ...entry,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}

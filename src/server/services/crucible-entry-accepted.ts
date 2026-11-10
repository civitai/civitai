import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { crucibleTeamAwardSubscriber } from '~/server/events/crucible-team-award';
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
 * idempotent. `accept` only reaches subscribers whose eventTags match the crucible; `revoke` reaches
 * every subscriber.
 */
export type CrucibleEntrySubscriber = {
  name: string;
  eventTags: readonly string[];
  accept: (entry: CrucibleEntryRef & { acceptedAt: Date }) => Promise<void>;
  revoke: (entry: CrucibleEntryRef) => Promise<void>;
};

export const CRUCIBLE_ENTRY_SUBSCRIBERS: readonly CrucibleEntrySubscriber[] = [
  crucibleTeamAwardSubscriber,
];

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

const interested = (subscribers: readonly CrucibleEntrySubscriber[], tags: readonly string[]) =>
  subscribers.filter((s) => s.eventTags.some((tag) => tags.includes(tag)));

/** Read from the primary, so a withdraw or removal that just committed is seen. */
async function isStillAcceptable(entryId: number) {
  const [row] = await dbWrite.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok
    FROM "CrucibleEntry" ce
    JOIN "Crucible" c ON c.id = ce."crucibleId"
    JOIN "Image" i ON i.id = ce."imageId"
    WHERE ce.id = ${entryId}
      AND c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      AND c."endAt" > now()
      AND ${visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, 0)}
  `;
  return !!row?.ok;
}

/**
 * Accepts an entry: every interested subscriber runs, and only once all of them succeed is the
 * entry recorded as accepted. A failure takes the entry back from the subscribers that ran, then
 * throws and leaves it unrecorded for the next sweep.
 * Returns false when it was already accepted, or judges can no longer see it.
 *
 * A removal or withdrawal commits before it revokes, so the entry is checked on the primary before
 * the subscribers run and again once it is recorded: a revoke that landed in between, before a
 * subscriber had granted anything, is repeated.
 */
export async function acceptCrucibleEntry(
  entry: CrucibleEntryRef,
  subscribers: readonly CrucibleEntrySubscriber[] = CRUCIBLE_ENTRY_SUBSCRIBERS,
  // From a caller that already read them: the crucible's tags, and that the entry is unrecorded.
  known: { tags?: readonly string[]; unrecorded?: boolean } = {}
) {
  const key = acceptedKey(entry.crucibleId);
  const field = String(entry.entryId);
  if (!known.unrecorded && (await sysRedis.hExists(key, field))) return false;
  if (!(await isStillAcceptable(entry.entryId))) return false;

  const acceptedAt = new Date();
  const targets = interested(subscribers, known.tags ?? (await crucibleTags(entry.crucibleId)));
  for (const [i, subscriber] of targets.entries()) {
    try {
      await subscriber.accept({ ...entry, acceptedAt });
    } catch (error) {
      // All or nothing: the entry stays unrecorded, so what the earlier subscribers (and this one,
      // partway) granted would otherwise outlive a departure no revoke reaches.
      await revokeCrucibleEntry(entry, targets.slice(0, i + 1));
      throw error;
    }
  }

  await sysRedis.hSet(key, field, JSON.stringify({ at: acceptedAt, userId: entry.userId }));
  await sysRedis.expire(key, ACCEPTED_TTL_SECONDS);
  if (!(await isStillAcceptable(entry.entryId))) {
    await revokeCrucibleEntry(entry, subscribers);
    return false;
  }

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
    // Every subscriber, not the crucible's current tags: a tag removed since the accept would
    // otherwise skip the subscriber that granted it. Revoking what was never granted is a no-op.
    for (const subscriber of subscribers) {
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

// Most entries one sweep accepts; the rest wait for the next.
const MAX_ACCEPTS_PER_SWEEP = 200;

const getTaggedRunningCrucibles = (eventTags: string[]) =>
  dbRead.$queryRaw<{ id: number; eventTags: string[] }[]>`
    SELECT c.id, c."eventTags" FROM "Crucible" c
    WHERE c."eventTags" && ${eventTags}::text[]
      AND c.status = ${CrucibleStatus.Active}::"CrucibleStatus"
      AND c."endAt" > now()
  `;

/** One crucible's judgeable entries outside `acceptedIds`, oldest first. */
const getUnacceptedJudgeableEntries = (crucibleId: number, acceptedIds: number[], limit: number) =>
  dbRead.$queryRaw<CrucibleEntryRef[]>`
    SELECT ce.id AS "entryId", ce."crucibleId", ce."userId"
    FROM "Crucible" c
    JOIN "CrucibleEntry" ce ON ce."crucibleId" = c.id
    JOIN "Image" i ON i.id = ce."imageId"
    WHERE c.id = ${crucibleId}
      AND ce.id <> ALL(${acceptedIds}::int[])
      AND ${visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, 0)}
    ORDER BY ce.id
    LIMIT ${limit}
  `;

/**
 * Revokes one crucible's accepted entries that left without a removal or a withdrawal calling
 * revoke: a deleted image leaves the row with no image, and a deleted account takes the row with
 * it. Returns the ids still accepted.
 */
async function revokeDepartedEntries(
  crucibleId: number,
  accepted: Record<string, string>,
  subscribers: readonly CrucibleEntrySubscriber[]
) {
  const entryIds = Object.keys(accepted).map(Number);
  if (!entryIds.length) return { kept: [] as number[], revoked: 0 };
  const present = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT id FROM "CrucibleEntry"
    WHERE id = ANY(${entryIds}::int[]) AND "imageId" IS NOT NULL
  `;
  const kept = new Set(present.map((e) => e.id));
  let revoked = 0;
  for (const entryId of entryIds) {
    if (kept.has(entryId)) continue;
    // The row may be gone with its entrant, so who entered comes from the record.
    const { userId } = JSON.parse(accepted[String(entryId)]) as { userId: number };
    await revokeCrucibleEntry({ entryId, crucibleId, userId }, subscribers);
    revoked++;
  }
  return { kept: [...kept], revoked };
}

/**
 * Takes back accepted entries that have left the crucible, then accepts the new ones, at most
 * MAX_ACCEPTS_PER_SWEEP in all. Theme-reviewed crucibles are left to the review.
 */
export async function sweepAcceptedCrucibleEntries(
  subscribers: readonly CrucibleEntrySubscriber[] = CRUCIBLE_ENTRY_SUBSCRIBERS
) {
  const result = { accepted: 0, failed: 0, revoked: 0, skipped: false };
  const tags = subscribedTags(subscribers);
  if (!tags.length) return result;

  const reviews = await getCrucibleThemeReviews();
  result.skipped = !reviews;
  const reviewed = new Set(reviews?.map((r) => r.crucibleId));
  let budget = MAX_ACCEPTS_PER_SWEEP;

  for (const crucible of await getTaggedRunningCrucibles(tags)) {
    const accepted = await sysRedis.hGetAll(acceptedKey(crucible.id));
    const { kept, revoked } = await revokeDepartedEntries(crucible.id, accepted, subscribers);
    result.revoked += revoked;
    if (!reviews || reviewed.has(crucible.id) || budget <= 0) continue;

    const entries = await getUnacceptedJudgeableEntries(crucible.id, kept, budget);
    budget -= entries.length;
    for (const entry of entries) {
      try {
        const done = await acceptCrucibleEntry(entry, subscribers, {
          tags: crucible.eventTags,
          unrecorded: true,
        });
        if (done) result.accepted++;
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

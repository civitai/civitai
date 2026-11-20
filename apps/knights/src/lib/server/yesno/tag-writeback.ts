import { sql, type Kysely } from 'kysely';
import { mergeMeta, MOD_TAG_REVIEW_SOURCE } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  createModeratorClient,
  ModeratorClientError,
  type ImageTagModerateInput,
  type ImageTagModerateResult,
} from '@civitai/moderation';
import { backoffMinutes, MAX_APPLY_ATTEMPTS } from '../queue/queue.service';
import { settledAtNeeded } from './decide';
import { EPISODE_ENDED_META_KEY, tagIdOf } from './tag-review';

/** The moderator action is not there yet (not deployed, not configured, credential not accepted): try again later, uncounted. */
export class TagWriteBackNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagWriteBackNotReady';
  }
}

export type TagReviewPort = {
  moderate: (input: ImageTagModerateInput) => Promise<ImageTagModerateResult>;
};

const isConnectionRefused = (error: unknown): boolean => {
  for (let at: unknown = error, depth = 0; at && depth < 4; depth++) {
    if ((at as { code?: unknown }).code === 'ECONNREFUSED') return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * The moderator app's `image-tag-moderate` action, through `@civitai/moderation`'s client with the path-scoped credential.
 * An unset URL or token, a 404 (an app without the action), a 401 (the credential not accepted yet) and a refused
 * connection are "not ready"; anything else is a failure.
 */
export function createTagReviewPort({
  endpoint,
  token,
  fetch: doFetch = fetch,
}: {
  endpoint: string | undefined;
  token: string | undefined;
  fetch?: typeof fetch;
}): TagReviewPort {
  return {
    async moderate(input) {
      if (!endpoint?.trim() || !token?.trim())
        throw new TagWriteBackNotReady(
          'the moderator app URL or KNIGHTS_TAG_REVIEW_TOKEN is not set'
        );
      let refused = false;
      const client = createModeratorClient({
        endpoint: endpoint.trim(),
        token: token.trim(),
        fetch: (url, init) =>
          doFetch(url, init).catch((error: unknown) => {
            refused = isConnectionRefused(error);
            throw error;
          }),
      });
      try {
        return await client.imageTagModerate(input);
      } catch (error) {
        const status = error instanceof ModeratorClientError ? error.status : undefined;
        if (refused || status === 404 || status === 401)
          throw new TagWriteBackNotReady(
            refused
              ? 'the moderator app refused the connection'
              : `the moderator app answered ${status}`
          );
        throw error;
      }
    },
  };
}

const LEASE_MINUTES = 2;
/** How soon an item waiting on a moderator app that is not ready is tried again. Not counted as an attempt. */
export const NOT_READY_RETRY_MINUTES = 5;

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

export type TagWriteBackResult = {
  applied: number;
  /** Final answers that wrote nothing: the tag was already ruled, the image is staff-only now, or it is gone. */
  skipped: number;
  /** Waiting on a moderator app that is not ready. */
  waiting: number;
  failed: number;
  /** Gave up after `MAX_APPLY_ATTEMPTS`; the tag stays with moderators. */
  exhausted: number;
};

/**
 * Writes Paladin consensus on tag review items back to the moderator app: "yes" keeps the tag, "no" removes it, as the
 * player who closed the consensus. Each item is claimed with a short lease, so two ticks never call for the same one.
 *
 * `applied` stamps `appliedAt` and ends the flag episode. Every other answer is final too and stamps `appliedAt` with the
 * outcome as `reason`; `already-ruled` also ends the episode (the flag is clear), `ineligible` and `missing` do not.
 * A moderator app that is not ready leaves the item to the next try without spending an attempt. Any other failure
 * backs off (`backoffMinutes`) and counts; at `MAX_APPLY_ATTEMPTS` the item stops as `attempts-exhausted`, still a paid
 * consensus, and its tag stays in the moderators' queue. Never handed to the Inquisitors.
 */
export async function writeBackTagReviews(
  db: Kysely<DB>,
  port: TagReviewPort,
  { now, enabled, limit = 50 }: { now: Date; enabled: boolean; limit?: number }
): Promise<TagWriteBackResult> {
  const result: TagWriteBackResult = {
    applied: 0,
    skipped: 0,
    waiting: 0,
    failed: 0,
    exhausted: 0,
  };
  if (!enabled) return result;

  const due = await db
    .selectFrom('KnightsQueueItem')
    .select('id')
    .where('status', '=', 'Consensus')
    .where('appliedAt', 'is', null)
    .where('source', '=', MOD_TAG_REVIEW_SOURCE)
    .where('reason', 'is', null)
    .where('applyAttempts', '<', MAX_APPLY_ATTEMPTS)
    .where((eb) => eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', utc(now))]))
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();

  for (const { id } of due) {
    const claimed = await db
      .updateTable('KnightsQueueItem')
      .set({ nextAttemptAt: utc(addMinutes(now, LEASE_MINUTES)) })
      .where('id', '=', id)
      .where('status', '=', 'Consensus')
      .where('appliedAt', 'is', null)
      .where('reason', 'is', null)
      .where((eb) => eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', utc(now))]))
      .returning(['imageId', 'meta', 'minRank', 'resolvedValue', 'resolvedBy', 'applyAttempts'])
      .executeTakeFirst();
    if (!claimed) continue;

    const tagId = tagIdOf(claimed.meta);
    const answers = await db
      .selectFrom('KnightsVote')
      .select(['answer', 'weight'])
      .where('itemId', '=', id)
      .where('stage', '=', claimed.minRank)
      .execute();

    try {
      if (tagId === null || claimed.resolvedBy === null)
        throw new Error('the item names no tag or no player');
      const answer = await port.moderate({
        imageId: claimed.imageId,
        tagId,
        disable: claimed.resolvedValue === 'no',
        userId: claimed.resolvedBy,
        settledAtMinimum: settledAtNeeded(answers, claimed.minRank),
      });
      const endsEpisode = answer.outcome === 'applied' || answer.outcome === 'already-ruled';
      await db
        .updateTable('KnightsQueueItem')
        .set({
          appliedAt: utc(now),
          nextAttemptAt: null,
          reason: answer.outcome === 'applied' ? null : answer.outcome,
          updatedAt: utc(now),
          ...(endsEpisode ? { meta: mergeMeta({ [EPISODE_ENDED_META_KEY]: true }) } : {}),
        })
        .where('id', '=', id)
        .execute();
      if (answer.outcome === 'applied') result.applied++;
      else result.skipped++;
    } catch (error) {
      if (error instanceof TagWriteBackNotReady) {
        result.waiting++;
        console.warn('knights: the tag review write-back is waiting on the moderator app', {
          itemId: id,
          message: error.message,
        });
        await db
          .updateTable('KnightsQueueItem')
          .set({ nextAttemptAt: utc(addMinutes(now, NOT_READY_RETRY_MINUTES)) })
          .where('id', '=', id)
          .execute();
        continue;
      }
      const attempts = claimed.applyAttempts + 1;
      const exhausted = attempts >= MAX_APPLY_ATTEMPTS;
      console.error(
        exhausted
          ? 'knights: gave up writing back a tag review consensus; the tag stays with moderators'
          : 'knights: could not write back a tag review consensus, it will be retried',
        { itemId: id, attempt: attempts, error }
      );
      await db
        .updateTable('KnightsQueueItem')
        .set({
          applyAttempts: sql<number>`"applyAttempts" + 1`,
          nextAttemptAt: exhausted ? null : utc(addMinutes(now, backoffMinutes(attempts))),
          ...(exhausted ? { reason: 'attempts-exhausted' } : {}),
        })
        .where('id', '=', id)
        .execute();
      if (exhausted) result.exhausted++;
      else result.failed++;
    }
  }
  return result;
}

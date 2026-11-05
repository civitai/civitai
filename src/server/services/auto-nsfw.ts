import type { ProfanityEvaluation } from '~/libs/profanity-simple';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { SYSTEM_NSFW_LOCK_META_KEY } from '@civitai/shared/rating-review';
import { Prisma } from '@prisma/client';
import {
  heldLeadSql,
  onlyPrivateHoldsRatingSql,
} from '~/server/services/text-scan/actions/hold-restricted-verdict';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

/**
 * The exact keys the interactive upsert paths already write into `Model.meta` / `Bounty.details`.
 * Built here rather than at each call site so the fan-out records a detection in the shape the
 * moderation tooling already reads — a second spelling would be invisible to it.
 */
export type AutoNsfwMetaPatch = {
  profanityMatches: string[] | undefined;
  profanityEvaluation: { reason: string; metrics: ProfanityEvaluation['metrics'] };
};

export type AutoNsfwResult = {
  metaPatch: AutoNsfwMetaPatch;
  /**
   * False when a moderator has already pinned `nsfw`. The detection is still worth recording for
   * review, but the filter must never overturn a moderator's call.
   */
  lock: boolean;
};

/**
 * The auto-NSFW decision for a title + body pair.
 *
 * 🔴 One function, reachable from BOTH the interactive upsert and the blurb fan-out. The fan-out
 * rewrites an already-published description with text the upsert's gate never saw, so a gate that
 * lives only on the form-shaped path is a way to change published content past it: publish with a
 * clean blurb, then edit the blurb.
 *
 * Returns null when nothing should change.
 */
export function evaluateAutoNsfw({
  name,
  description,
  alreadyNsfw,
  lockedProperties,
}: {
  name?: string | null;
  description?: string | null;
  alreadyNsfw: boolean;
  lockedProperties: string[];
}): AutoNsfwResult | null {
  if (alreadyNsfw) return null;

  const text = [name, description].filter(Boolean).join(' ');
  if (!text) return null;

  const evaluation = createProfanityFilter().evaluateContent(text);
  if (!evaluation.shouldMarkNSFW) return null;

  return {
    metaPatch: {
      profanityMatches: evaluation.matchedWords,
      profanityEvaluation: { reason: evaluation.reason, metrics: evaluation.metrics },
    },
    lock: !lockedProperties.includes('nsfw'),
  };
}

/**
 * Writes an {@link evaluateAutoNsfw} result in one statement over the row as it is when locked: a
 * meta read earlier and written back would drop whatever a moderator or a scan set since, and a
 * publish landing between separate statements could leave the model with neither the rating nor the
 * lead. The lock and its `systemNsfwLock` marker land only where no nsfw lock exists yet and the model
 * is not minor, POI, SFW-only or Private (as `upsertModel`'s own profanity check); otherwise only the
 * detection is recorded. Where being Private is the only reason, the verdict is also held as a
 * moderator's lead that applies when the model leaves Private. `updatedAt` is bumped: the model's rating changed.
 */
export async function writeAutoNsfw(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  { id, metaPatch, lock }: { id: number } & AutoNsfwResult
) {
  const nsfwUnlocked = Prisma.sql`NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))`;
  const locks = lock
    ? Prisma.sql`(${nsfwUnlocked} AND NOT (m.minor OR m.poi OR m."sfwOnly")
        AND m.availability <> 'Private')`
    : Prisma.sql`FALSE`;
  const holds = lock
    ? Prisma.sql`(${nsfwUnlocked} AND ${onlyPrivateHoldsRatingSql})`
    : Prisma.sql`FALSE`;
  await db.$executeRaw`
    UPDATE "Model" m
    SET nsfw = CASE WHEN ${locks} THEN TRUE ELSE m.nsfw END,
        "lockedProperties" = CASE WHEN ${locks}
          THEN array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw')
          ELSE m."lockedProperties" END,
        meta = ${asJsonbObjectSql('m.meta')} || ${JSON.stringify(metaPatch)}::jsonb || CASE
          WHEN ${locks} THEN jsonb_build_object(
            ${SYSTEM_NSFW_LOCK_META_KEY}::text,
            jsonb_build_object('source', 'profanity-filter', 'at', now())
          )
          WHEN ${holds} THEN ${heldLeadSql('profanity-filter')}
          ELSE '{}'::jsonb END,
        "updatedAt" = now()
    WHERE m.id = ${id}`;
}

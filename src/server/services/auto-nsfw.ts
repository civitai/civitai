import type { ProfanityEvaluation } from '~/libs/profanity-simple';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { SYSTEM_NSFW_LOCK_META_KEY } from '@civitai/shared/rating-review';
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
 * Writes an {@link evaluateAutoNsfw} result: jsonb merges, never a meta read earlier and written
 * back, which would drop whatever a moderator or a scan set since. The lock and its
 * `systemNsfwLock` marker land only where no nsfw lock exists yet; otherwise (nothing to lock, or a
 * moderator's lock landed since the read) only the detection is recorded. `updatedAt` is bumped:
 * the model's rating changed.
 */
export async function writeAutoNsfw(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  { id, metaPatch, lock }: { id: number } & AutoNsfwResult
) {
  const patch = JSON.stringify(metaPatch);
  const locked = lock
    ? await db.$executeRaw`
        UPDATE "Model" m
        SET nsfw = TRUE,
            "lockedProperties" = array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw'),
            meta = ${asJsonbObjectSql('m.meta')} || ${patch}::jsonb || jsonb_build_object(
              ${SYSTEM_NSFW_LOCK_META_KEY}::text,
              jsonb_build_object('source', 'profanity-filter', 'at', now())
            ),
            "updatedAt" = now()
        WHERE m.id = ${id}
          AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))`
    : 0;
  if (!locked)
    await db.$executeRaw`
      UPDATE "Model" m
      SET meta = ${asJsonbObjectSql('m.meta')} || ${patch}::jsonb, "updatedAt" = now()
      WHERE m.id = ${id}`;
}

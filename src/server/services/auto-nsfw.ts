import type { ProfanityEvaluation } from '~/libs/profanity-simple';
import { createProfanityFilter } from '~/libs/profanity-simple';

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

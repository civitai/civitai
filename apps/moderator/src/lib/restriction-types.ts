/**
 * The kinds of review that file into the moderator mute queue.
 *
 * `UserRestriction.type` is free text in the database with a `[type, status]` index, so a new kind of
 * review costs no migration — it files into the same queue under a different type. The list is
 * enumerated here rather than derived from the rows so the queue's filter cannot be driven to an
 * arbitrary string from the URL, and so a type nobody built a view for cannot render an empty page
 * that reads as "no work to do".
 *
 * 🔴 This file is deliberately OUTSIDE `$lib/server/`. `RestrictionFilters.svelte` renders the type
 * picker and therefore needs these as VALUES; SvelteKit rejects a value import of `$lib/server/*` from
 * client-reachable code, and the sibling components only get away with importing from the service
 * because theirs are `import type` and erase. Keep the list here and re-export it from the service.
 *
 * Mirrored for the main app in `src/server/services/user-restriction.service.ts`; the two lists are
 * pinned to each other by `src/server/services/__tests__/restriction-type-seam.test.ts`.
 */
export const RESTRICTION_TYPES = ['generation', 'bot-account'] as const;
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

/** What the queue shows when the URL names no type — the only type that existed before the seam. */
export const RESTRICTION_TYPE: RestrictionType = 'generation';

export const RESTRICTION_TYPE_LABELS: Record<RestrictionType, string> = {
  generation: 'Generation',
  'bot-account': 'Bot account',
};

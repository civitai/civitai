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
 * pinned to each other by `src/server/services/__tests__/restriction-type-seam.test.ts`, which
 * imports and executes this module rather than reading it as text.
 */
export const RESTRICTION_TYPES = ['generation', 'bot-account'] as const;
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

/** What the queue shows when the URL names no type — the only type that existed before the seam. */
export const RESTRICTION_TYPE: RestrictionType = 'generation';

export const RESTRICTION_TYPE_LABELS: Record<RestrictionType, string> = {
  generation: 'Generation',
  'bot-account': 'Bot account',
};

/**
 * The types a VERDICT can be handed to — narrower than `RESTRICTION_TYPES`, which is what may be
 * filed and reviewed.
 *
 * The refusal itself is enforced by the main app, one level below every ruling surface, in
 * `resolveUserRestriction` — this app's ruling forms all post through `/api/mod/restriction/resolve`.
 * This list is the same rule read forward instead of backward: it is what lets a form that cannot
 * possibly succeed be disabled rather than merely rejected, and what lets the audit queue refuse a
 * ban BEFORE it bans (that action bans and then rules, so a late refusal would leave the account
 * banned against a restriction nobody can close).
 *
 * 🔴 Kept identical to the main app's `RULINGS_WIRED_FOR` by
 * `src/server/services/__tests__/restriction-type-seam.test.ts`, which IMPORTS AND EXECUTES this
 * module and compares the resulting values. The two apps are separate builds with no runtime import
 * path between them, so a pinned copy is the strongest available form of "one rule, one place" — do
 * not fork it by hand.
 *
 * 🔴 That guard used to parse this file as TEXT, and passed green over a real divergence: a `]` in a
 * trailing comment truncated its capture. So KEEP THIS MODULE IMPORT-FREE. It has no imports today,
 * and that is the only reason the main app's Vitest project can load it across the app boundary;
 * adding a `$lib/…` import here breaks the seam guard loudly rather than silently, but it does break
 * it.
 */
export const RULINGS_WIRED_FOR: readonly RestrictionType[] = ['generation'];

/** Why a ruling may not be handed to a row of this type, or `null` when it may. */
export function unwiredRulingReason(type: string): string | null {
  return (RULINGS_WIRED_FOR as readonly string[]).includes(type)
    ? null
    : `Rulings are not yet available for "${type}" restrictions — the verdict path still sends generation-specific notices. This restriction was NOT resolved.`;
}

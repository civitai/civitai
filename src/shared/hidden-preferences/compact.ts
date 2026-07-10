// Compact wire shape for `hiddenPreferences.getHidden`.
//
// WHY: `getHidden` returns a user's ENTIRE hidden set. For a power-user who has
// hidden thousands of models/images, the legacy response wraps every id in a
// `{ id, hidden: true }` object. superjson re-serializes that whole object tree
// SYNCHRONOUSLY on every response — INCLUDING Redis cache hits (the cache saves
// the DB read, not the serialize) — freezing the Node event loop (observed:
// 803ms p99 / 1151ms max serializeMs / 12.4MB, the single worst per-event freeze
// on civitai-dp-prod; see instrument `trpc-response-oversized`). This is the
// structural twin of `user.getEngagedModels` (PR #3028/#3034).
//
// The full membership set is genuinely needed client-side for feed filtering, so
// it CANNOT be paginated/capped. Instead we strip the pure-overhead object
// wrapping on the id-only sets (models / model3ds / explicit hidden images):
// the wire carries `number[]` instead of `{ id, hidden: true }[]`, which both
// shrinks bytes ~6x AND — the real win — collapses thousands of superjson object
// nodes to a flat number array (the per-node walk is what pegs the event loop).
// Sets that carry real payload (tags: name/nsfwLevel, users: username) stay as
// objects — their data is used verbatim on the account pages.
//
// The client (`useQueryHiddenPreferences`) EXPANDS this back to the legacy
// `HiddenPreferenceTypes` shape so the ~30 downstream consumers are untouched.
// A `__v` discriminator lets both the read-expander and the optimistic-update
// path detect the shape unambiguously (empty arrays are otherwise ambiguous),
// and lets a stale client bundle from a rolling deploy keep working against
// either shape. Emission is flag-gated (`hiddenPrefsCompact`) so it can be
// ramped via Flipt and rolled back instantly.

import produce from 'immer';
import type {
  HiddenImage,
  HiddenPreferenceTypes,
  HiddenTag,
  HiddenUser,
} from '~/server/services/user-preferences.service';

// Bump if the compact shape ever changes in a non-additive way.
export const HIDDEN_PREFS_COMPACT_VERSION = 2 as const;

// The id-only sets that the compact shape flattens to `number[]`. These are the
// keys the optimistic-update path must treat as numbers (not objects) when the
// cache holds the compact shape. `hiddenImages` here is EXPLICIT hides only —
// implicit (tag-vote) hidden images carry a `tagId` and live in
// `hiddenImagesImplicit`.
export const COMPACT_ID_KEYS = ['hiddenModels', 'hiddenModel3Ds', 'hiddenImages'] as const;
export type CompactIdKey = (typeof COMPACT_ID_KEYS)[number];

export type HiddenPreferencesCompact = {
  __v: typeof HIDDEN_PREFS_COMPACT_VERSION;
  hiddenTags: HiddenTag[];
  hiddenUsers: HiddenUser[];
  hiddenModels: number[];
  hiddenModel3Ds: number[];
  /** explicit `hide image` engagements, id-only */
  hiddenImages: number[];
  /** images hidden implicitly by a hidden/moderated tag vote — carry `tagId` */
  hiddenImagesImplicit: HiddenImage[];
  blockedUsers: HiddenUser[];
  blockedByUsers: HiddenUser[];
};

export function isCompactHiddenPreferences(
  data: HiddenPreferenceTypes | HiddenPreferencesCompact | null | undefined
): data is HiddenPreferencesCompact {
  return (
    !!data && (data as HiddenPreferencesCompact).__v === HIDDEN_PREFS_COMPACT_VERSION
  );
}

/**
 * Build the compact wire shape from the fully-materialized legacy sets. Runs
 * server-side, right before superjson serializes the tRPC response. Splits the
 * merged `hiddenImages` back into explicit ids + implicit (tagId-bearing)
 * objects so `expandHiddenPreferences` can reconstruct the exact legacy order.
 */
export function toCompactHiddenPreferences(
  data: HiddenPreferenceTypes
): HiddenPreferencesCompact {
  const explicitImages: number[] = [];
  const implicitImages: HiddenImage[] = [];
  for (const img of data.hiddenImages) {
    // implicit (tag-vote) images carry a tagId; explicit hides do not
    if (img.tagId != null) implicitImages.push(img);
    else explicitImages.push(img.id);
  }

  return {
    __v: HIDDEN_PREFS_COMPACT_VERSION,
    hiddenTags: data.hiddenTags,
    hiddenUsers: data.hiddenUsers,
    hiddenModels: data.hiddenModels.map((x) => x.id),
    hiddenModel3Ds: data.hiddenModel3Ds.map((x) => x.id),
    hiddenImages: explicitImages,
    hiddenImagesImplicit: implicitImages,
    blockedUsers: data.blockedUsers,
    blockedByUsers: data.blockedByUsers,
  };
}

/**
 * Normalize whatever `getHidden` returned (compact OR legacy OR undefined) into
 * the legacy `HiddenPreferenceTypes` shape the downstream consumers expect.
 *
 * Field-level coalescing is preserved from the pre-existing hook: rolling
 * deploys / stale SSR hydration can serve a response that predates a field
 * (e.g. `hiddenModel3Ds`), and a missing top-level key would crash a consumer
 * on `.map(...)`. Every field defaults to `[]`.
 */
export function expandHiddenPreferences(
  data: HiddenPreferenceTypes | HiddenPreferencesCompact | null | undefined
): HiddenPreferenceTypes {
  if (isCompactHiddenPreferences(data)) {
    return {
      hiddenTags: data.hiddenTags ?? [],
      hiddenUsers: data.hiddenUsers ?? [],
      hiddenModels: (data.hiddenModels ?? []).map((id) => ({ id, hidden: true })),
      hiddenModel3Ds: (data.hiddenModel3Ds ?? []).map((id) => ({ id, hidden: true })),
      // legacy order: explicit hides first, then implicit tag-vote images
      hiddenImages: [
        ...(data.hiddenImages ?? []).map((id) => ({ id, hidden: true })),
        ...(data.hiddenImagesImplicit ?? []),
      ],
      blockedUsers: data.blockedUsers ?? [],
      blockedByUsers: data.blockedByUsers ?? [],
    };
  }

  return {
    hiddenModels: data?.hiddenModels ?? [],
    hiddenModel3Ds: data?.hiddenModel3Ds ?? [],
    hiddenImages: data?.hiddenImages ?? [],
    hiddenTags: data?.hiddenTags ?? [],
    hiddenUsers: data?.hiddenUsers ?? [],
    blockedUsers: data?.blockedUsers ?? [],
    blockedByUsers: data?.blockedByUsers ?? [],
  };
}

// ---------------------------------------------------------------------------
// Optimistic-cache mutation (shape-aware)
//
// The tRPC query cache holds whatever `getHidden` returned — compact OR legacy.
// The optimistic `toggleHidden` path mutates that cache in-place, so it must
// write the shape the cache is currently in: bare ids for the compact id-only
// sets, `{ id, hidden }` objects otherwise. These pure helpers encapsulate that
// branching (kept out of the React hook so they're unit-testable).
// ---------------------------------------------------------------------------

type HiddenCache = HiddenPreferenceTypes | HiddenPreferencesCompact;

const compactIdKeySet = new Set<string>(COMPACT_ID_KEYS);

// Is `key` stored as a bare `number[]` in THIS cache blob? Only when the cache
// holds the compact shape AND the key is an id-only set. Tags/users/blocked stay
// objects even in the compact shape, and everything is objects in the legacy shape.
function isCompactIdKey(cache: HiddenCache, key: string): key is CompactIdKey {
  return isCompactHiddenPreferences(cache) && compactIdKeySet.has(key);
}

/** Add/remove a single id in an id-only `number[]` set (compact shape). */
function toggleCompactId(arr: number[], id: number, hidden?: boolean) {
  const index = arr.indexOf(id);
  if (hidden === true && index === -1) arr.push(id);
  else if (hidden === false && index > -1) arr.splice(index, 1);
  else if (hidden === undefined) {
    if (index > -1) arr.splice(index, 1);
    else arr.push(id);
  }
}

/** Add/remove a single item in an object-wrapped set (legacy shape). */
function toggleLegacyItem(arr: Array<{ id: number; hidden?: boolean }>, item: { id: number }, hidden?: boolean) {
  const index = arr.findIndex((x) => x.id === item.id && x.hidden);
  if (hidden === true && index === -1) arr.push({ ...item, hidden: true });
  else if (hidden === false && index > -1) arr.splice(index, 1);
  else if (hidden === undefined) {
    if (index > -1) arr.splice(index, 1);
    else arr.push({ ...item, hidden: true });
  }
}

/**
 * Optimistic toggle (client-side, pre-server): apply add/remove/toggle of the
 * given `items` to `cache[key]` — mirrors the pre-existing legacy semantics for
 * object sets, and the id-only equivalent when the cache is compact.
 */
export function applyOptimisticHiddenToggle(
  cache: HiddenCache,
  key: string,
  items: Array<{ id: number }>,
  hidden?: boolean
): HiddenCache {
  return produce(cache, (draft: any) => {
    if (isCompactIdKey(draft, key)) {
      const arr = draft[key] as number[];
      for (const item of items) toggleCompactId(arr, item.id, hidden);
      return;
    }
    for (const item of items) toggleLegacyItem(draft[key], item, hidden);
  });
}

/**
 * Reconcile the cache with the server's authoritative `added`/`removed` diff
 * (the `toggleHidden` mutation result). Same shape-branching as the optimistic
 * path; object sets replace-in-place to pick up server-provided fields.
 */
export function applyServerHiddenToggle(
  cache: HiddenCache,
  key: string,
  added: Array<{ id: number }>,
  removed: Array<{ id: number }>
): HiddenCache {
  return produce(cache, (draft: any) => {
    if (isCompactIdKey(draft, key)) {
      const arr = draft[key] as number[];
      for (const { id } of added) toggleCompactId(arr, id, true);
      for (const { id } of removed) toggleCompactId(arr, id, false);
      return;
    }
    for (const { kind, id, ...props } of added as Array<Record<string, unknown> & { id: number }>) {
      const index = draft[key].findIndex((x: any) => x.id === id && x.hidden);
      if (index === -1) draft[key].push({ id, ...props });
      else draft[key][index] = { id, ...props };
    }
    for (const { kind, id, ...props } of removed as Array<Record<string, unknown> & { id: number }>) {
      const index = draft[key].findIndex((x: any) => x.id === id && x.hidden);
      if (index > -1) draft[key].splice(index, 1);
    }
  });
}

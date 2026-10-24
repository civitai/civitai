import { browsingLevelLabels, parseBitwiseBrowsingLevel } from '@civitai/shared';

/**
 * How ONE `context.filters` entry is rendered in the detail panel.
 *
 * `title` carries the RAW stored value whenever `text` is a decode of it. A moderator comparing a
 * report against a database row needs the number, and a panel that only ever shows the decode has
 * thrown it away.
 */
export type FormattedFilterValue = {
  text: string;
  /** `null` when `text` IS the stored value, so there is nothing to disclose. */
  title: string | null;
};

export type FilterValue = string | number | boolean;

/**
 * The rendering `context.filters` has always had, kept verbatim.
 *
 * `'none'` is the marketplace context builder's "no category selected" sentinel — an explicit
 * `undefined` fails the context schema's value union, so absence had to be spelled — and `''` is an
 * empty search box. Neither is a value the reporter chose, so neither is shown as one.
 */
export function genericFilterValue(value: FilterValue): FormattedFilterValue {
  if (value === 'none') return { text: '(none)', title: null };
  if (value === '') return { text: '—', title: null };
  return { text: String(value), title: null };
}

/** `Feedback.context` rides a JSONB column, but the column this mirrors is a Postgres `int4`. */
const INT4_MAX = 0x7fffffff;

const labelFor = (bit: number): string | null =>
  (browsingLevelLabels as Record<number, string | undefined>)[bit] ?? null;

/**
 * 🔴 `browsingLevel` IS A BITMASK, NOT AN ENUM VALUE — a bare `browsingLevelLabels[value]` lookup is
 * correct for `1` and WRONG for every composite, and it is wrong SILENTLY: the lookup misses and the
 * panel renders nothing, or renders `?`. Measured against production, the values actually present on
 * `bitdex-image-feed` rows are `1, 3, 7, 28, 30, 31` — five of the six are sums.
 *
 * Returns `null` rather than a string when the stored value is not something an `int4` browsing level
 * could be. That is the FALL-THROUGH signal: the caller then renders it generically, so a key that
 * one day holds a string is shown as that string instead of as a confident, wrong `?`.
 *
 * A bit with no label is rendered `+<bit>` rather than dropped. Dropping it would silently narrow the
 * report — the moderator would see `PG` for a value that also carried something this app has never
 * heard of — and `+64` is visibly not a rating, which is the point.
 */
export function formatBrowsingLevel(value: FilterValue): FormattedFilterValue | null {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value) || value < 0 || value > INT4_MAX) return null;

  const raw = String(value);
  // `0` is "no level recorded". `browsingLevelLabels` spells it `?` and that is the shared answer.
  if (value === 0) return { text: labelFor(0) ?? '?', title: raw };

  // Ascending bit order, so the rendering runs PG → XXX rather than in whatever order the bits were
  // OR'd together. Every bit inside the int4 bound is covered by `Flags.possibleValues` (2^0…2^31),
  // which is why the bound above is a precondition and not decoration.
  const parts = parseBitwiseBrowsingLevel(value).map((bit) => labelFor(bit) ?? `+${bit}`);
  return { text: parts.join(', '), title: raw };
}

/**
 * The one area whose `browsingLevel` filter is a bitmask.
 *
 * 🔴 NO LIVE PRODUCER WRITES THAT KEY — which is weaker than "no row can carry it", and is the claim
 * the evidence supports. Measured over the whole repo: the live feedback-context builders are
 * `src/components/Apps/appsStoreFeedbackContext.ts` (writes `kind`, `category`, `sort`, `query`) and
 * `src/components/Feedback/FeedbackDrawer.tsx` (writes `path` only); neither writes `browsingLevel`,
 * and BitDex was decommissioned 2026-09-01. The 23 historical `bitdex-image-feed` rows are the
 * population this decode was built for.
 *
 * ⚠️ THAT ENUMERATION CANNOT BOUND THE COLUMN, and an earlier revision here read it as if it could
 * ("the only area that can carry that key AT ALL"). It enumerates THIS repo's writers at one moment;
 * `context` is schemaless JSONB and `area` is free TEXT, so a historical writer or a future one in
 * another deployable is outside what any search of this repo can see. That is exactly why the `area`
 * half of the guard below is load-bearing rather than belt-and-braces.
 */
const BITMASK_BROWSING_LEVEL_AREA = 'bitdex-image-feed';

/**
 * The one entry point the panel calls. Every other `(area, key)` keeps today's generic rendering.
 *
 * 🔴 GUARDED ON `area` AS WELL AS `key`, and a bare `if (key === 'browsingLevel')` is the bug this
 * shape exists to refuse. `context.filters` is `Record<string, string | number | boolean>` written by
 * whichever surface mounted the prompt; `browsingLevel` means a bitmask on `bitdex-image-feed` and
 * nothing at all anywhere else. A key match alone would relabel a future area's identically-named
 * value as a content rating — a wrong answer that reads exactly like a right one.
 *
 * 🔴 TWO `===` COMPARISONS, NOT A LOOKUP, AND THAT IS THE POINT. Both `area` and `key` are untrusted
 * — `area` is a stored TEXT column and `key` comes out of a JSONB blob with no schema at rest. An
 * earlier revision of this file indexed them into a two-level registry, which is exactly the surface
 * where `'toString'` resolves to an inherited FUNCTION that then gets CALLED (a `Map` closed that,
 * but only by hardening a lookup that did not need to exist for a one-entry table). A comparison has
 * no prototype chain to harden. **If a keyed lookup ever comes back here it must be a `Map`** — see
 * the repo's own live lesson where `scope in MAP` passed 12 prototype keys as known.
 */
export function formatFeedbackFilterValue(
  area: string,
  key: string,
  value: FilterValue
): FormattedFilterValue {
  if (area === BITMASK_BROWSING_LEVEL_AREA && key === 'browsingLevel') {
    return formatBrowsingLevel(value) ?? genericFilterValue(value);
  }
  return genericFilterValue(value);
}

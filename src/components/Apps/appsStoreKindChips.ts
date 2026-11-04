import type { ListingKindFilter } from '~/server/schema/blocks/app-listing-read.schema';

/** The two listing kinds a viewer can switch off: embedded (on Civitai) and standalone (off-site). */
export type AppsStoreKindChip = 'onsite' | 'offsite';

export const APPS_STORE_KIND_CHIPS: readonly AppsStoreKindChip[] = ['onsite', 'offsite'];

/**
 * The kind chips that read as ON for a stored `kind`. `all` is none on: with nothing picked every
 * app shows, and there is no separate "All apps" chip.
 */
export function kindChipsOn(kind: ListingKindFilter): AppsStoreKindChip[] {
  return kind === 'all' ? [] : [kind];
}

/**
 * The stored `kind` for the chips left on. None on, or both on, is `all`: a filter that matches
 * nothing is never useful, so switching off the last chip puts both back.
 */
export function kindFromChips(on: readonly string[]): ListingKindFilter {
  const picked = APPS_STORE_KIND_CHIPS.filter((chip) => on.includes(chip));
  return picked.length === 1 ? picked[0] : 'all';
}

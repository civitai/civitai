import type { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import type { ReviewQueueFilterType } from '~/components/CreatorShop/Submit/submit.constants';
import { reviewQueueTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';

/**
 * Reading the moderator review queue's linkable filters out of the URL.
 *
 * The queue is linkable at all because the moderation nav now has a Sticker
 * Review entry pointing at `?type=sticker` — and a nav entry needs a URL to
 * point at. Every filter on that page was local `useState`, so there was no link
 * to give it and no bookmark survived a reload; the pending sticker queue was
 * reachable only by opening "Creator Shop Review" and knowing to narrow it by
 * hand, which is how it "just gets lost in the all".
 *
 * Parsing lives here rather than in the page so it can be tested without
 * mounting a moderator screen, and so the two readers cannot drift.
 *
 * Unknown values are ignored rather than rejected: a hand-edited URL should open
 * the default queue, not an error page.
 */

export type StatusFilter = CosmeticShopItemStatus | 'all';

/**
 * The valid `?status=` values. Passed in by the page rather than re-declared
 * here, so the link and the dropdown can never offer different sets.
 */
export function statusFromQuery(
  value: unknown,
  options: readonly { value: StatusFilter }[]
): StatusFilter | null {
  if (typeof value !== 'string') return null;
  const match = options.find(
    (option) => String(option.value).toLowerCase() === value.trim().toLowerCase()
  );
  return match ? match.value : null;
}

export function typesFromQuery(value: unknown): ReviewQueueFilterType[] {
  // `?type=a&type=b` arrives as an array, a single one as a string, and
  // `?type=a,b` as one comma-joined string — which is what this page writes.
  const raw = Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    : typeof value === 'string'
    ? value.split(',')
    : [];

  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    const match = reviewQueueTypeOptions.find(
      (option) => option.value.toLowerCase() === entry.trim().toLowerCase()
    );
    // Deduped: `?type=sticker,sticker` would otherwise send the same type twice
    // to the query, and the filter row would render two identical chips.
    if (!match || seen.has(match.value)) return [];
    seen.add(match.value);
    return [match.value as ReviewQueueFilterType];
  });
}

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  statusFromQuery,
  typesFromQuery,
} from '~/components/CreatorShop/Submit/review-queue-query';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * 🔒 Ties the two ends of the moderator half of this feature together.
 *
 * The "Sticker Review" nav entry is a hand-written literal in one file; the
 * parsers that have to understand it live in another, and their tests hand-type
 * the same strings. So `?cosmeticType=sticker`, or a typo in the status, leaves
 * every other test in this feature green while the nav entry opens an
 * unfiltered queue — which is the exact state the entry exists to fix, and it
 * would look like it was working.
 *
 * This reads the href out of the nav source and runs it through the real
 * parsers. It is the assertion that makes review-queue-query.test.ts matter.
 *
 * Idiom borrowed from `appsStoreAccessCallSites.test.ts` and
 * `no-stale-moderator-route-probe.test.ts` — a source-gate, not a render.
 */
const navSource = fs.readFileSync(
  path.resolve(__dirname, '../../../Moderation/ModerationNav.tsx'),
  'utf-8'
);

/** Every `/moderator/creator-shop…` href the nav declares. */
function creatorShopHrefs(): string[] {
  return [...navSource.matchAll(/href:\s*'(\/moderator\/creator-shop[^']*)'/g)].map((m) => m[1]);
}

describe('the Sticker Review nav entry', () => {
  it('is still there, alongside the unfiltered queue', () => {
    const hrefs = creatorShopHrefs();

    // Two entries, one bare and one filtered. If this drops to one, either the
    // feature was reverted or the href moved somewhere this test cannot see —
    // both of which make every assertion below vacuous.
    expect(hrefs).toContain('/moderator/creator-shop');
    expect(hrefs.filter((href) => href.includes('?'))).toHaveLength(1);
  });

  it('carries a query the page parsers actually understand', () => {
    const filtered = creatorShopHrefs().find((href) => href.includes('?'))!;
    const params = new URLSearchParams(filtered.split('?')[1]);

    // The parsers, not a copy of their rules.
    expect(typesFromQuery(params.get('type'))).toEqual([CosmeticType.Sticker]);
    expect(
      statusFromQuery(params.get('status'), [
        { value: CosmeticShopItemStatus.PendingReview },
        { value: CosmeticShopItemStatus.Published },
        { value: 'all' as const },
      ])
    ).toBe(CosmeticShopItemStatus.PendingReview);
  });

  it('uses the param names the page reads', () => {
    const filtered = creatorShopHrefs().find((href) => href.includes('?'))!;
    const params = new URLSearchParams(filtered.split('?')[1]);
    const page = fs.readFileSync(
      path.resolve(__dirname, '../../../../pages/moderator/creator-shop.tsx'),
      'utf-8'
    );

    // Renaming the param on either side breaks here rather than silently
    // opening an unfiltered queue.
    for (const key of params.keys()) {
      expect(page).toContain(`router.query.${key}`);
    }
  });
});

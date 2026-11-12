import { describe, expect, it } from 'vitest';

import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import { buildListingDetailPreview } from '~/components/Apps/reviewListingPreview';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The SUPPORT row (the issue-tracker link) in the listing detail rail.
 *
 *   - present right AFTER Source, labelled "Support", linking to the full URL;
 *   - its `rel` is `noopener noreferrer nofollow ugc` — any host, author-chosen;
 *   - present in `preview` too (the shadow carries it and approving publishes it);
 *   - absent for null / empty / a non-string that crossed a cast.
 */

const fmt = (iso: string) => `formatted:${iso}`;
type Input = Parameters<typeof buildListingDetailRows>[0];

const REPO = 'https://github.com/civitai/support-row-app';
const TRACKER = 'https://help.support-row-7313.example.test/issues';

function detail(over: Partial<ListingDetail> = {}): Input {
  return {
    kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'https://a.civit.ai' },
    category: 'utility',
    contentRating: 'pg',
    recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.75 },
    reviewCount: 4,
    installCount: 11,
    openCount: 13,
    updatedAt: '2026-03-04T05:06:07.000Z',
    ...over,
  } as Input;
}

const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

describe('buildListingDetailRows — the Support row', () => {
  it('sits immediately after Source, before reviews', () => {
    const rows = buildListingDetailRows(detail({ sourceRepoUrl: REPO, issueTrackerUrl: TRACKER }), {
      formatDate: fmt,
    });
    expect(keys(rows)).toEqual([
      'kind',
      'category',
      'rating',
      'source',
      'support',
      'reviews',
      'plays',
      'updated',
    ]);
  });

  it('renders without a Source row too (the two are independent)', () => {
    const rows = buildListingDetailRows(detail({ issueTrackerUrl: TRACKER }), { formatDate: fmt });
    expect(keys(rows)).toContain('support');
    expect(keys(rows)).not.toContain('source');
  });

  it('label, display value without the scheme, full href, and the widened rel', () => {
    const row = buildListingDetailRows(detail({ issueTrackerUrl: TRACKER }), {
      formatDate: fmt,
    }).find((r) => r.key === 'support')!;
    expect(row).toEqual({
      key: 'support',
      label: 'Support',
      value: 'help.support-row-7313.example.test/issues',
      href: TRACKER,
      rel: 'noopener noreferrer nofollow ugc',
    });
  });

  it('the Source row keeps the default rel (only Support widens it)', () => {
    const source = buildListingDetailRows(detail({ sourceRepoUrl: REPO }), {
      formatDate: fmt,
    }).find((r) => r.key === 'source')!;
    expect(source.rel).toBeUndefined();
  });

  it('is present in PREVIEW posture — the moderator must see what approving publishes', () => {
    const rows = buildListingDetailRows(detail({ issueTrackerUrl: TRACKER }), {
      preview: true,
      formatDate: fmt,
    });
    expect(keys(rows)).toEqual(['kind', 'category', 'rating', 'support']);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a non-string from a cast producer', 12345],
    ['absent', undefined],
  ])('is OMITTED for %s', (_label, value) => {
    const input = { ...detail(), issueTrackerUrl: value } as unknown as Input;
    expect(keys(buildListingDetailRows(input, { formatDate: fmt }))).not.toContain('support');
  });

  it('the fallback review preview carries issueTrackerUrl: null (the field exists, no row)', () => {
    const preview = buildListingDetailPreview({
      id: 'alpr_1',
      slug: 'x',
      status: 'pending',
      submittedAt: '2026-03-04T05:06:07.000Z',
    } as never);
    expect('issueTrackerUrl' in preview).toBe(true);
    expect(preview.issueTrackerUrl).toBeNull();
  });
});

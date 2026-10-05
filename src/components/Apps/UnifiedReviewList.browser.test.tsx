import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type { OffsitePendingRow } from './OffsiteReviewQueue';
import type { OffsiteReviewRequest, OnsiteReviewRequest } from './unifiedReviewRow';

/**
 * The unified moderator review LIST — browser-mode render test (report-only in
 * Tekton; the pure adapters/merge in `unifiedReviewRow.test.ts` are the blocking
 * gate). Asserts a list built from ONE on-site + ONE off-site row:
 *  - renders BOTH rows with the correct kind badge (App / External);
 *  - orders oldest-first for `direction="asc"` (pending);
 *  - clicking a row's Review invokes the CORRECT opener (on-site → openOnsite with
 *    the original request; off-site → openOffsite with the built OffsitePendingRow),
 *    NEVER the other — the core no-cross-routing invariant;
 *  - the Version / Submitter / Plays / age / icon cells, including both `—` cases;
 *  - the two `stopPropagation` guards, which are the only thing stopping a click on the
 *    author link or the version trigger from ALSO opening a review.
 */

/*
  Stubbed: the real `UserAvatar` reaches providers this harness does not mount. The stub
  keeps this cell's whole contract with it — WHICH user, and whether it renders a profile
  LINK — so the propagation guard below runs against a real `<a>`. Precedent:
  `~/components/Reaction/ImageReactorsPreview.browser.test.tsx`.
*/
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({
    user,
    linkToProfile,
  }: {
    user: { id: number; username?: string | null };
    linkToProfile?: boolean;
  }) =>
    linkToProfile ? (
      <a href={`/user/${user.username ?? user.id}`} data-testid="submitter-link">
        {user.username ?? '[deleted]'}
      </a>
    ) : (
      <span>{user.username ?? '[deleted]'}</span>
    ),
}));

const ONSITE: OnsiteReviewRequest = {
  id: 'or1',
  appBlockId: null,
  slug: 'my-onsite',
  version: '1.0.0',
  submittedAt: '2026-01-01T00:00:00Z', // older → first under asc
  bundleSizeBytes: '10',
  bundleSha256: 'sha',
  manifest: { name: 'Lighthouse' },
  fileSummary: {},
  manifestDiffSummary: {},
  reviewRepoUrl: 'https://forgejo.example/repo',
  submittedBy: { id: 7, username: 'onsite-dev', deletedAt: null, image: null },
} as OnsiteReviewRequest;

const OFFSITE: OffsiteReviewRequest = {
  id: 'fr1',
  appListingId: 'apl_1',
  slug: 'my-offsite',
  status: 'pending',
  submittedAt: '2026-02-01T00:00:00Z', // newer → second under asc
  changelog: null,
  appListing: {
    // 🔴 A NEUTRAL NAME, DELIBERATELY. This fixture used to be called 'My External App'
    // — a listing NAME that spells a retired kind wording, which (a) makes it
    // indistinguishable from a copy defect to any scanner and (b) is exactly the
    // fixture shape that can satisfy a kind-badge assertion by accident. Fixture values
    // must be distinct from every constant an assertion names.
    name: 'Wayfarer',
    externalUrl: 'https://ex.com',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 9, username: 'offsite-dev', deletedAt: null, image: null },
};

const { UnifiedReviewList } = await import('./UnifiedReviewList');
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
const { renderWithProviders, LOADABLE_IMAGE_DATA_URI: PIXEL } = await import(
  // The shared loadable data: URI, not an http(s) URL — `local-rules/no-unloadable-image-fixture`
  // records what an un-serveable src costs a browser test.
  '../../../test/component-setup'
);

function renderList(overrides?: {
  openOnsite?: (r: OnsiteReviewRequest) => void;
  openOffsite?: (r: OffsitePendingRow) => void;
  openVersionHistory?: (t: { slug: string; currentRequestId: string | null }) => void;
  onsiteItems?: OnsiteReviewRequest[];
  offsiteItems?: OffsiteReviewRequest[];
}) {
  const openOnsite = overrides?.openOnsite ?? vi.fn();
  const openOffsite = overrides?.openOffsite ?? vi.fn();
  const openVersionHistory = overrides?.openVersionHistory ?? vi.fn();
  renderWithProviders(
    <UnifiedReviewList
      onsiteItems={overrides?.onsiteItems ?? [ONSITE]}
      offsiteItems={overrides?.offsiteItems ?? [OFFSITE]}
      direction="asc"
      openOnsiteReview={openOnsite}
      openOffsiteReview={openOffsite}
      openVersionHistory={openVersionHistory}
      isLoading={false}
      emptyLabel="empty"
      dateLabel="Submitted"
      actionLabel="Review"
      hasMore={false}
      onLoadMore={vi.fn()}
    />
  );
  return { openOnsite, openOffsite, openVersionHistory };
}

describe('UnifiedReviewList — renders both kinds with correct badges', () => {
  test('both rows render with App / Standalone kind badges', async () => {
    renderList();
    await expect
      .element(page.getByTestId('apps-unified-review-kind-onsite:or1'))
      .toHaveTextContent('App');
    await expect
      .element(page.getByTestId('apps-unified-review-kind-offsite:fr1'))
      .toHaveTextContent('Standalone');
    // Both apps' names surface.
    await expect.element(page.getByText('Lighthouse')).toBeInTheDocument();
    await expect.element(page.getByText('Wayfarer')).toBeInTheDocument();
  });

  test('oldest-first order under direction="asc" (on-site row precedes off-site)', async () => {
    renderList();
    // Wait for the async render to commit before the synchronous `.elements()`
    // read — reading immediately after renderList() races the mount and returns 0.
    await expect
      .element(page.getByTestId('apps-unified-review-row-onsite:or1'))
      .toBeInTheDocument();
    const rows = page.getByTestId(/^apps-unified-review-row-/).elements();
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-testid')).toBe('apps-unified-review-row-onsite:or1');
    expect(rows[1].getAttribute('data-testid')).toBe('apps-unified-review-row-offsite:fr1');
  });
});

describe('UnifiedReviewList — Review routes to the correct modal opener (no cross)', () => {
  test('clicking the on-site row Review invokes openOnsite with the original request only', async () => {
    const { openOnsite, openOffsite } = renderList();
    await page.getByTestId('apps-unified-review-action-onsite:or1').click();
    expect(openOnsite).toHaveBeenCalledTimes(1);
    expect(openOnsite).toHaveBeenCalledWith(ONSITE);
    expect(openOffsite).not.toHaveBeenCalled();
  });

  test('clicking the off-site row Review invokes openOffsite with the built row only', async () => {
    const { openOnsite, openOffsite } = renderList();
    await page.getByTestId('apps-unified-review-action-offsite:fr1').click();
    expect(openOffsite).toHaveBeenCalledTimes(1);
    const passed = (openOffsite as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passed.id).toBe('fr1');
    expect(passed.appListingId).toBe('apl_1');
    expect(passed.slug).toBe('my-offsite');
    expect(openOnsite).not.toHaveBeenCalled();
  });
});

describe('UnifiedReviewList — the Version column', () => {
  test('a FIRST version renders the semver and the violet first-version badge', async () => {
    renderList({
      onsiteItems: [
        {
          ...ONSITE,
          version: '0.1.0',
          manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
        } as OnsiteReviewRequest,
      ],
    });
    await expect
      .element(page.getByTestId('apps-unified-review-version-onsite:or1'))
      .toHaveTextContent('0.1.0');
    // 🔴 THE EXACT WORDING `OnsiteReviewModalTitle` USES. The queue and the review surface
    // a moderator opens from it must not spell one verdict two ways.
    await expect
      .element(page.getByTestId('apps-unified-review-first-version-onsite:or1'))
      .toHaveTextContent('first version');
  });

  test('an UPDATE diff renders the semver and NO badge', async () => {
    renderList({
      onsiteItems: [
        {
          ...ONSITE,
          version: '4.5.6',
          manifestDiffSummary: { kind: 'update', added: [], removed: [], changed: [] },
        } as OnsiteReviewRequest,
      ],
    });
    await expect
      .element(page.getByTestId('apps-unified-review-version-onsite:or1'))
      .toHaveTextContent('4.5.6');
    expect(page.getByTestId('apps-unified-review-first-version-onsite:or1').elements()).toEqual([]);
  });

  test('a LISTING row renders an em dash, no badge and no trigger', async () => {
    renderList();
    await expect
      .element(page.getByTestId('apps-unified-review-version-offsite:fr1'))
      .toHaveTextContent('—');
    expect(page.getByTestId('apps-unified-review-first-version-offsite:fr1').elements()).toEqual(
      []
    );
    expect(page.getByTestId('apps-unified-review-version-trigger-offsite:fr1').elements()).toEqual(
      []
    );
  });
});

describe('UnifiedReviewList — the Plays column', () => {
  test('a count renders the store card wording', async () => {
    renderList({
      onsiteItems: [{ ...ONSITE, playCount: 12_400 } as OnsiteReviewRequest],
    });
    // `getPlayCountLabel` → `abbreviateNumber`, so the queue and the public card agree.
    await expect
      .element(page.getByTestId('apps-unified-review-row-onsite:or1'))
      .toHaveTextContent('12.4k plays');
  });

  test('a count of ONE is singular', async () => {
    renderList({ onsiteItems: [{ ...ONSITE, playCount: 1 } as OnsiteReviewRequest] });
    const plays = page.getByTestId('apps-unified-review-plays-onsite:or1');
    await expect.element(plays).toBeInTheDocument();
    // `toHaveTextContent` is a SUBSTRING match, and "1 plays" contains "1 play" — so the
    // named property needs the exact read to be observable at all.
    expect(plays.element().textContent).toBe('1 play');
  });

  test('ZERO and UNKNOWN both render an em dash, never "0 plays"', async () => {
    // `getPlayCountLabel` returns null for 0 on purpose; honouring it is the point.
    renderList({
      onsiteItems: [
        { ...ONSITE, id: 'zero', playCount: 0 } as OnsiteReviewRequest,
        { ...ONSITE, id: 'unknown' } as OnsiteReviewRequest,
      ],
      offsiteItems: [],
    });
    for (const id of ['zero', 'unknown']) {
      const row = page.getByTestId(`apps-unified-review-row-onsite:${id}`);
      await expect.element(row).toBeInTheDocument();
      expect(row.element().textContent).not.toContain('0 plays');
      expect(row.element().textContent).toContain('—');
    }
  });
});

describe('🔴 UnifiedReviewList — the Plays header carries its caveats', () => {
  /**
   * The figure is not public usage and the cell's own wording ("12.4k plays", shared with
   * the public store card) reads exactly as if it were. The header is the only place that
   * can say otherwise, so what it says is pinned — all four properties, because a header
   * carrying three of them is the misreading this exists to stop.
   *
   * 🔴 NO AUDIENCE WORDING ASSERTED, AND THAT IS THE POINT. Copy naming who can reach the
   * run page would be false the day `app-blocks-pages-enabled` widens, with nothing to
   * tell you — so the copy describes the COUNTER, and this test refuses the other shape.
   */
  test('the header states all four properties of the counter', async () => {
    renderList({ onsiteItems: [{ ...ONSITE, playCount: 12_400 } as OnsiteReviewRequest] });
    await expect.element(page.getByTestId('apps-unified-review-count')).toBeInTheDocument();
    const th = [...document.querySelectorAll('th')].find((h) =>
      (h.textContent ?? '').includes('Plays')
    );
    expect(th, 'no Plays header rendered').toBeTruthy();
    const caveat = th!.getAttribute('title') ?? '';
    // (1) what it counts, (2) not deduped, (3) flag-limited, (4) off-site is unmeasurable.
    expect(caveat).toMatch(/run page/i);
    expect(caveat).toMatch(/not deduplicated/i);
    expect(caveat).toMatch(/flag-limited/i);
    expect(caveat).toMatch(/unmeasurable, not zero/i);
    // …and it does NOT describe an audience, which is the half that would go stale.
    expect(caveat).not.toMatch(/moderator|dev.?tester|internal team|staff/i);
  });
});

describe('UnifiedReviewList — the relative age cell', () => {
  test('renders a compact age and keeps the exact timestamp in title + dateTime', async () => {
    renderList();
    const age = page.getByTestId('apps-unified-review-age-onsite:or1');
    await expect.element(age).toBeInTheDocument();
    const el = age.element() as HTMLTimeElement;
    // 🔴 `now` MUST STAY EXCLUDED: `compactRelativeTime(now, now)` instead of the row's
    // date reads `now` on every row while `dateTime`, `title` and the pure ladder test all
    // stay green. The fixture date is fixed and in the past, so months-or-years is durable.
    expect(el.textContent).toMatch(/^\d+(mo|y)$/);
    expect(el.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
    // The exact instant stays reachable on hover and to a screen reader.
    expect(el.getAttribute('title')).toBe(new Date('2026-01-01T00:00:00Z').toLocaleString());
    expect(el.getAttribute('title')).not.toBe(el.textContent);
  });
});

describe('UnifiedReviewList — the listing icon in the App cell', () => {
  test('an icon URL renders an img sized to reserve its box', async () => {
    renderList({ onsiteItems: [{ ...ONSITE, iconUrl: PIXEL } as OnsiteReviewRequest] });
    const img = page.getByTestId('apps-unified-review-icon-onsite:or1');
    await expect.element(img).toBeInTheDocument();
    const el = img.element() as HTMLImageElement;
    // Both attributes present is what stops the row reflowing when the bytes land.
    expect(el.getAttribute('width')).toBe('40');
    expect(el.getAttribute('height')).toBe('40');
    expect(el.getAttribute('loading')).toBe('lazy');
    expect(page.getByTestId('apps-unified-review-icon-placeholder-onsite:or1').elements()).toEqual(
      []
    );
  });

  test('NO icon renders the same-sized placeholder, and it is NOT a control', async () => {
    renderList();
    const placeholder = page.getByTestId('apps-unified-review-icon-placeholder-onsite:or1');
    await expect.element(placeholder).toBeInTheDocument();
    expect(placeholder.element().tagName).toBe('DIV');
    expect(page.getByTestId('apps-unified-review-icon-onsite:or1').elements()).toEqual([]);
  });

  test('🔴 the icon is NEVER a control in the queue — present or absent', async () => {
    /**
     * The queue shows the icon for identity and does not open it: judging store media at
     * 40px is worse than opening the submission, which shows icon AND cover at full size.
     * Asserted STRUCTURALLY rather than by the absence of a testid — a `data-testid` the
     * code no longer emits is a vacuous check, where "no ancestor button" stays true
     * however the thumbnail is re-wired.
     */
    renderList({ onsiteItems: [{ ...ONSITE, iconUrl: PIXEL } as OnsiteReviewRequest] });
    const img = page.getByTestId('apps-unified-review-icon-onsite:or1');
    await expect.element(img).toBeInTheDocument();
    expect(img.element().closest('button'), 'the queue icon is wrapped in a button').toBeNull();
    // …and the cell it sits in still opens the review, so the row is not inert.
    const { openOnsite } = renderList({
      onsiteItems: [{ ...ONSITE, id: 'ctl', iconUrl: PIXEL } as OnsiteReviewRequest],
      offsiteItems: [],
    });
    await expect
      .element(page.getByTestId('apps-unified-review-row-onsite:ctl'))
      .toBeInTheDocument();
    const cell = document
      .querySelector('[data-testid="apps-unified-review-row-onsite:ctl"]')!
      .querySelectorAll('td')[1] as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openOnsite).toHaveBeenCalledTimes(1);
  });
});

describe('🔴 UnifiedReviewList — the stopPropagation guards', () => {
  /**
   * Both guards exist because the row is whole-row-clickable. Without them ONE click does
   * two things, and the second — opening a review surface — is the one a moderator then
   * has to back out of.
   */
  test('clicking the AUTHOR LINK does not open the review', async () => {
    const { openOnsite, openVersionHistory } = renderList();
    await expect.element(page.getByTestId('submitter-link').first()).toBeInTheDocument();
    // A real click on the anchor would NAVIGATE the harness iframe and kill the run, so the
    // default is cancelled on the link itself — ahead of the guard, which sits on the span
    // wrapping it, so what the guard sees is the same bubbling event a user produces.
    const link = page.getByTestId('submitter-link').first().element();
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openOnsite).not.toHaveBeenCalled();
    expect(openVersionHistory).not.toHaveBeenCalled();
  });

  test('…but clicking ELSEWHERE in the submitter cell still opens the review', async () => {
    // The negative control for the guard above: it is scoped to the chip, not the cell, so
    // a guard that swallowed the whole cell would pass the previous test and fail this one.
    const { openOnsite } = renderList();
    await expect
      .element(page.getByTestId('apps-unified-review-row-onsite:or1'))
      .toBeInTheDocument();
    const cell = document
      .querySelector('[data-testid="apps-unified-review-row-onsite:or1"]')!
      .querySelectorAll('td')[3] as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openOnsite).toHaveBeenCalledTimes(1);
  });

  test('clicking the VERSION TRIGGER opens the history modal and NOT the review', async () => {
    const { openOnsite, openVersionHistory } = renderList({
      onsiteItems: [
        {
          ...ONSITE,
          version: '2.3.4',
          manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
        } as OnsiteReviewRequest,
      ],
    });
    await page.getByTestId('apps-unified-review-version-trigger-onsite:or1').click();
    expect(openVersionHistory).toHaveBeenCalledTimes(1);
    expect(openVersionHistory).toHaveBeenCalledWith({
      slug: 'my-onsite',
      currentRequestId: 'or1',
      title: 'Lighthouse',
    });
    expect(openOnsite).not.toHaveBeenCalled();
  });

  test('…but clicking ELSEWHERE in the version cell still opens the review', async () => {
    const { openOnsite, openVersionHistory } = renderList();
    await expect
      .element(page.getByTestId('apps-unified-review-row-onsite:or1'))
      .toBeInTheDocument();
    const cell = document
      .querySelector('[data-testid="apps-unified-review-row-onsite:or1"]')!
      .querySelectorAll('td')[2] as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openOnsite).toHaveBeenCalledTimes(1);
    expect(openVersionHistory).not.toHaveBeenCalled();
  });
});

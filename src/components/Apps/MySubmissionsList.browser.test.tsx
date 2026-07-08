import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import dayjs from '~/shared/utils/dayjs';
import { formatDate } from '~/utils/date-helpers';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * /apps/my-submissions LIST — component tests for the UX-pass cleanup:
 *   1. The "Changes" column is gone (header + the +/~/- file-diff badges).
 *   2. Reviewer notes are NOT inline; a "See reviewer notes" button shows ONLY
 *      when notes exist and opens the notes in a modal.
 *   3. An approved row shows the compact runs/users (30d) inline stat + an
 *      "Analytics" button that opens AppAnalyticsPanel (scoped) in a modal; a
 *      non-approved row shows neither.
 *   4. The authoring footnote (the "civitai CLI" guidance + the collapsed
 *      "Advanced: author via git" panel) is GONE — it no longer renders on any
 *      row (own submissions don't need an author-via-git affordance here).
 *
 * tRPC + the heavy analytics panel are mocked per the documented scaffold
 * pattern so this stays network-free and chart-free.
 */

const mocks = vi.hoisted(() => ({
  analytics: { runs: { count: 0 }, engagement: { activeUsers: 0 } } as unknown,
  analyticsLoading: false,
  panelRenders: vi.fn(),
  // Spy on the analytics query so we can assert the input (e.g. the floored
  // `from`) every approved row passes — the per-row dedup key depends on it.
  analyticsUseQuery: vi.fn(),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getMyAppAnalytics: {
        useQuery: (...args: unknown[]) => {
          mocks.analyticsUseQuery(...args);
          return { data: mocks.analytics, isLoading: mocks.analyticsLoading };
        },
      },
      // getMyApps is used only by the (mocked-away) panel; keep a stub so any
      // accidental call is harmless.
      getMyApps: { useQuery: () => ({ data: [], isLoading: false }) },
      getMyAppRepo: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
  },
}));

// The real AppAnalyticsPanel pulls in chart.js; replace it with a marker that
// records the scoped appBlockId it was opened with.
vi.mock('~/components/AppBlocks/AppAnalyticsPanel', () => ({
  AppAnalyticsPanel: ({ scopedAppBlockId }: { scopedAppBlockId?: string }) => {
    mocks.panelRenders(scopedAppBlockId);
    return <div data-testid="analytics-panel">analytics-panel:{scopedAppBlockId}</div>;
  },
}));

// Type-only import is erased at runtime, so it's safe above the dynamic value
// import (which must come AFTER the hoisted vi.mock calls).
import type { Submission } from './MySubmissionsList';
const { MySubmissionsList } = await import('./MySubmissionsList');

function makeSubmission(overrides: Partial<Submission>): Submission {
  return {
    id: 's1',
    appBlockId: 'block-1',
    slug: 'my-app',
    version: '1.0.0',
    status: 'approved',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedAt: new Date('2026-01-02T00:00:00Z'),
    rejectionReason: null,
    approvalNotes: null,
    deployState: 'live',
    deployDetail: null,
    deployUpdatedAt: new Date('2026-01-02T00:00:00Z'),
    fileSummary: { added: ['a.js'], changed: ['b.js'], removed: ['c.js'] },
    manifestDiffSummary: { kind: 'update', added: [], removed: [], changed: [] },
    modelInstallCount: 3,
    userSubscriptionCount: 5,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.analytics = { runs: { count: 0 }, engagement: { activeUsers: 0 } };
  mocks.analyticsLoading = false;
  mocks.panelRenders.mockClear();
  mocks.analyticsUseQuery.mockClear();
});

describe('MySubmissionsList', () => {
  test('the "Changes" column header is NOT rendered', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({})]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Sanity: the table painted (a known-kept header is present).
    await expect.element(page.getByText('Submitted', { exact: true })).toBeInTheDocument();
    // The "Changes" column header is gone.
    expect(page.getByText('Changes', { exact: true }).elements()).toHaveLength(0);
    // The file-diff badges that lived in that column are gone too.
    expect(page.getByText('+1', { exact: true }).elements()).toHaveLength(0);
    expect(page.getByText('~1', { exact: true }).elements()).toHaveLength(0);
  });

  test('reviewer notes are NOT inline; "See reviewer notes" opens a modal with the notes', async () => {
    const notes = 'Please tighten the manifest scopes before next version.';
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({ approvalNotes: notes })]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Notes are NOT rendered inline up-front.
    expect(page.getByText(notes, { exact: false }).elements()).toHaveLength(0);
    // The trigger button is present.
    const btn = page.getByRole('button', { name: /see reviewer notes/i });
    await expect.element(btn).toBeInTheDocument();
    // Clicking it opens the modal with the notes.
    await btn.click();
    await expect.element(page.getByText(notes, { exact: false })).toBeInTheDocument();
  });

  test('"See reviewer notes" is ABSENT when a row has no notes', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({ approvalNotes: null, rejectionReason: null })]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('my-app', { exact: false })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /see reviewer notes/i }).elements()).toHaveLength(0);
  });

  test('"See reviewer notes" shows for a REJECTED row with a rejection reason', async () => {
    const reason = 'Rejected: the block requests an unapproved scope.';
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'r1',
            status: 'rejected',
            deployState: null,
            approvalNotes: null,
            rejectionReason: reason,
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // A rejected row now lives in the default-collapsed Rejected section — expand it.
    await page.getByTestId('apps-submissions-section-rejected-toggle').click();
    const btn = page.getByRole('button', { name: /see reviewer notes/i });
    await expect.element(btn).toBeInTheDocument();
    // Reason not inline.
    expect(page.getByText(reason, { exact: false }).elements()).toHaveLength(0);
    await btn.click();
    await expect.element(page.getByText(reason, { exact: false })).toBeInTheDocument();
  });

  test('an APPROVED row shows the inline 30d stat and an Analytics modal scoped to the app', async () => {
    mocks.analytics = { runs: { count: 1234 }, engagement: { activeUsers: 56 } };
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({ appBlockId: 'block-xyz' })]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Compact inline stat: runs + users.
    await expect.element(page.getByText('1,234', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('56', { exact: true })).toBeInTheDocument();

    // The Analytics button opens the (scoped) panel in a modal.
    const analyticsBtn = page.getByRole('button', { name: /analytics/i });
    await expect.element(analyticsBtn).toBeInTheDocument();
    await analyticsBtn.click();
    await expect.element(page.getByTestId('analytics-panel')).toBeInTheDocument();
    expect(mocks.panelRenders).toHaveBeenCalledWith('block-xyz');
  });

  test('the inline analytics `from` is floored to start-of-day, so same-app rows share one query key (per-row dedup)', async () => {
    // Two APPROVED versions of the SAME app block. They now COLLAPSE into one group
    // (latest shown; older behind a "2 versions" toggle), so expand to mount BOTH
    // inline stats. Pre-fix, each AppAnalyticsInline computed `from` at ms precision
    // per instance → two distinct query inputs → no React-Query dedup. The floor
    // (.startOf('day')) makes both rows pass the IDENTICAL input.
    const appBlockId = 'block-dedup';
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'v1',
            version: '1.0.0',
            appBlockId,
            submittedAt: new Date('2026-01-01T00:00:00Z'),
          }),
          makeSubmission({
            id: 'v2',
            version: '2.0.0',
            appBlockId,
            submittedAt: new Date('2026-02-01T00:00:00Z'),
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('my-app', { exact: false }).first()).toBeInTheDocument();
    // Expand the collapsed versions so the OLDER version's inline stat also mounts.
    await page.getByRole('button', { name: /versions/i }).click();

    // Every call carried the same app id.
    const inputs = mocks.analyticsUseQuery.mock.calls.map(
      (c) => c[0] as { appBlockId: string; from: string }
    );
    const appInputs = inputs.filter((i) => i?.appBlockId === appBlockId);
    expect(appInputs.length).toBeGreaterThanOrEqual(2); // both rows mounted an inline stat

    // (1) `from` is floored to a day boundary — TZ-agnostic: re-flooring a value
    // that's ALREADY at start-of-day is a no-op, so `from === startOf('day')(from)`.
    // (Asserting a literal `T00:00:00Z` would be wrong — `dayjs().startOf('day')`
    // floors to the LOCAL midnight, whose ISO carries the UTC offset.)
    const isFlooredToDay = (iso: string) =>
      dayjs(iso).valueOf() === dayjs(iso).startOf('day').valueOf();
    for (const i of appInputs) {
      expect(isFlooredToDay(i.from)).toBe(true);
    }

    // (2) Mutation-sanity: a ms-precision `from` (the pre-fix value, ~now) is NOT
    // on a day boundary, so reverting the `.startOf('day')` floor fails this test.
    expect(isFlooredToDay(new Date().toISOString())).toBe(false);

    // (3) The crux: identical `from` across same-app rows → identical input →
    // React-Query dedups to ONE in-flight query (not N).
    const uniqueFroms = new Set(appInputs.map((i) => i.from));
    expect(uniqueFroms.size).toBe(1);
  });

  test('a NON-approved (pending) row shows NO analytics affordance', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'p1',
            status: 'pending',
            deployState: null,
            reviewedAt: null,
            appBlockId: null,
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('my-app', { exact: false })).toBeInTheDocument();
    // No inline analytics stat, no Analytics button.
    expect(page.getByRole('button', { name: /^analytics$/i }).elements()).toHaveLength(0);
    expect(page.getByText('runs', { exact: true }).elements()).toHaveLength(0);
  });

  test('the authoring footnote (CLI guidance + Advanced author-via-git) is GONE on an approved row', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({ appBlockId: 'block-1' })]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // The approved row renders (its analytics stat is present).
    await expect.element(page.getByText('my-app', { exact: false })).toBeInTheDocument();
    // No authoring footnote anywhere: no CLI link, no CLI guidance text, no
    // "Advanced: author via git" toggle, and the git panel never mounts.
    expect(page.getByRole('link', { name: /civitai.*CLI/i }).elements()).toHaveLength(0);
    expect(page.getByText(/author and submit updates/i).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: /advanced.*git/i }).elements()).toHaveLength(0);
    expect(page.getByTestId('author-via-git').elements()).toHaveLength(0);
  });
});

describe('MySubmissionsList — UX pass: filter / sort / version-collapse', () => {
  test('the text filter narrows rows by app slug', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({ id: 'a', slug: 'alpha-app', appBlockId: 'block-a' }),
          makeSubmission({ id: 'b', slug: 'bravo-app', appBlockId: 'block-b' }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('alpha-app', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('bravo-app', { exact: false })).toBeInTheDocument();

    await page.getByTestId('apps-submissions-filter').fill('bravo');
    // Only the matching app remains.
    await expect.element(page.getByText('bravo-app', { exact: false })).toBeInTheDocument();
    expect(page.getByText('alpha-app', { exact: false }).elements()).toHaveLength(0);
  });

  test('multiple versions of one app collapse; the toggle reveals older versions', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'v1',
            version: '1.0.0',
            appBlockId: 'block-x',
            submittedAt: new Date('2026-01-01T00:00:00Z'),
          }),
          makeSubmission({
            id: 'v2',
            version: '2.0.0',
            appBlockId: 'block-x',
            submittedAt: new Date('2026-02-01T00:00:00Z'),
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Collapsed: only the newest version (2.0.0) is shown; 1.0.0 is hidden.
    await expect.element(page.getByText('2.0.0', { exact: true })).toBeInTheDocument();
    expect(page.getByText('1.0.0', { exact: true }).elements()).toHaveLength(0);

    // The "2 versions" toggle carries aria-expanded and reveals the older row.
    const toggle = page.getByRole('button', { name: /2 versions/i });
    expect(toggle.element().getAttribute('aria-expanded')).toBe('false');
    await toggle.click();
    await expect.element(page.getByText('1.0.0', { exact: true })).toBeInTheDocument();
    expect(toggle.element().getAttribute('aria-expanded')).toBe('true');
  });

  test('the "N versions" affordance lives in the App (title) cell, below the slug, and toggles', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'v1',
            version: '1.0.0',
            slug: 'title-app',
            appBlockId: 'block-t',
            submittedAt: new Date('2026-01-01T00:00:00Z'),
          }),
          makeSubmission({
            id: 'v2',
            version: '2.0.0',
            slug: 'title-app',
            appBlockId: 'block-t',
            submittedAt: new Date('2026-02-01T00:00:00Z'),
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    const toggle = page.getByRole('button', { name: /2 versions/i });
    await expect.element(toggle).toBeInTheDocument();
    // It sits in the SAME table cell as the app slug (i.e. under the title), not
    // in a separate column — the cell's text carries both the slug and the label.
    const cell = toggle.element().closest('td');
    expect(cell?.textContent).toContain('title-app');
    // And it still drives the expand/collapse.
    expect(page.getByText('1.0.0', { exact: true }).elements()).toHaveLength(0);
    await toggle.click();
    await expect.element(page.getByText('1.0.0', { exact: true })).toBeInTheDocument();
  });
});

describe('MySubmissionsList — status sections', () => {
  const oneOfEach = () => [
    makeSubmission({ id: 'a', slug: 'live-app', appBlockId: 'block-a', status: 'approved' }),
    makeSubmission({
      id: 'b',
      slug: 'pending-app',
      appBlockId: 'block-b',
      status: 'pending',
      deployState: null,
      reviewedAt: null,
    }),
    makeSubmission({
      id: 'c',
      slug: 'rejected-app',
      appBlockId: 'block-c',
      status: 'rejected',
      deployState: null,
      rejectionReason: null,
    }),
    makeSubmission({
      id: 'd',
      slug: 'withdrawn-app',
      appBlockId: 'block-d',
      status: 'withdrawn',
      deployState: null,
    }),
  ];

  test('groups submissions into Live/Pending/Rejected/Withdrawn sections', async () => {
    renderWithProviders(
      <MySubmissionsList submissions={oneOfEach()} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await expect.element(page.getByTestId('apps-submissions-section-live')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-submissions-section-pending'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-submissions-section-rejected'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-submissions-section-withdrawn'))
      .toBeInTheDocument();

    // Live + Pending are expanded → their rows are visible up-front.
    await expect.element(page.getByText('live-app', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('pending-app', { exact: false })).toBeInTheDocument();
  });

  test('Live + Pending render expanded; Rejected + Withdrawn are collapsed by default', async () => {
    renderWithProviders(
      <MySubmissionsList submissions={oneOfEach()} onWithdraw={vi.fn()} withdrawing={false} />
    );
    // Expanded sections: rows present.
    await expect.element(page.getByText('live-app', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('pending-app', { exact: false })).toBeInTheDocument();
    // Collapsed sections: their rows are NOT in the DOM until toggled.
    expect(page.getByText('rejected-app', { exact: false }).elements()).toHaveLength(0);
    expect(page.getByText('withdrawn-app', { exact: false }).elements()).toHaveLength(0);

    // The collapse toggles carry aria-expanded=false initially.
    const rejectedToggle = page.getByTestId('apps-submissions-section-rejected-toggle');
    expect(rejectedToggle.element().getAttribute('aria-expanded')).toBe('false');

    // Clicking a collapsed section's toggle reveals its rows.
    await rejectedToggle.click();
    await expect.element(page.getByText('rejected-app', { exact: false })).toBeInTheDocument();
    expect(rejectedToggle.element().getAttribute('aria-expanded')).toBe('true');
    // The Withdrawn section is still collapsed (independent toggle).
    expect(page.getByText('withdrawn-app', { exact: false }).elements()).toHaveLength(0);
  });

  test('empty sections are not rendered (only-approved submissions → no other sections)', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({ id: 'a', slug: 'live-app', appBlockId: 'block-a', status: 'approved' }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByTestId('apps-submissions-section-live')).toBeInTheDocument();
    expect(page.getByTestId('apps-submissions-section-pending').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-submissions-section-rejected').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-submissions-section-withdrawn').elements()).toHaveLength(0);
  });
});

describe('MySubmissionsList — UX pass 2: dates, author, first-version, live/Open-live', () => {
  test('submitted + reviewed dates render as "Month D, YYYY" with no time component', async () => {
    // Noon-UTC timestamps so the local-timezone calendar day is unambiguous.
    const submitted = new Date('2026-06-07T12:00:00Z');
    const reviewed = new Date('2026-06-09T12:00:00Z');
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({ submittedAt: submitted, reviewedAt: reviewed })]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Both dates print via the shared util in the whole-day "MMMM D, YYYY" form.
    await expect
      .element(page.getByText(formatDate(submitted, 'MMMM D, YYYY'), { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(formatDate(reviewed, 'MMMM D, YYYY'), { exact: true }))
      .toBeInTheDocument();
    // Mutation guard: the old `toLocaleString()` rendered an HH:MM(:SS) time — no
    // element anywhere in the table should contain a clock time now.
    expect(page.getByText(/\d:\d\d/).elements()).toHaveLength(0);
  });

  test('no submitter author/byline is rendered (own submissions — author is redundant)', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({})]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('my-app', { exact: false })).toBeInTheDocument();
    // No "by <username>" author chip and no link to a user profile.
    expect(page.getByText(/^by\s/i).elements()).toHaveLength(0);
    expect(
      page
        .getByRole('link')
        .elements()
        .filter((el) => (el.getAttribute('href') ?? '').startsWith('/user/'))
    ).toHaveLength(0);
  });

  test('the "first version" badge is never rendered', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            manifestDiffSummary: { kind: 'first-version', fields: ['name', 'description'] },
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('my-app', { exact: false })).toBeInTheDocument();
    expect(page.getByText('first version', { exact: true }).elements()).toHaveLength(0);
  });

  test('live badge + Open live appear ONLY on the currently-published version (latest approved)', async () => {
    // Two approved+live versions of one app. The newest (v2) is the published one;
    // the older (v1) must show a plain "approved" badge and NO "Open live".
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'v1',
            version: '1.0.0',
            appBlockId: 'block-p',
            status: 'approved',
            deployState: 'live',
            submittedAt: new Date('2026-01-01T00:00:00Z'),
          }),
          makeSubmission({
            id: 'v2',
            version: '2.0.0',
            appBlockId: 'block-p',
            status: 'approved',
            deployState: 'live',
            submittedAt: new Date('2026-02-01T00:00:00Z'),
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Collapsed: the latest (v2) is live + has an Open live button.
    await expect.element(page.getByText('live', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: /open live/i }))
      .toBeInTheDocument();

    // Expand the older version — it must NOT gain a second live badge / Open live.
    await page.getByRole('button', { name: /2 versions/i }).click();
    await expect.element(page.getByText('1.0.0', { exact: true })).toBeInTheDocument();
    expect(page.getByText('live', { exact: true }).elements()).toHaveLength(1);
    expect(page.getByRole('link', { name: /open live/i }).elements()).toHaveLength(1);
    // The older approved version now reads "approved", not "live".
    await expect.element(page.getByText('approved', { exact: true })).toBeInTheDocument();
  });

  test('when the latest version is still pending, the previous approved version is the live one', async () => {
    // v2 (newest) is pending review; v1 (older) is the approved+live version → the
    // live badge + Open live belong to v1, and NOTHING is live on the pending v2.
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'v1',
            version: '1.0.0',
            appBlockId: 'block-q',
            status: 'approved',
            deployState: 'live',
            submittedAt: new Date('2026-01-01T00:00:00Z'),
            reviewedAt: new Date('2026-01-02T00:00:00Z'),
          }),
          makeSubmission({
            id: 'v2',
            version: '2.0.0',
            appBlockId: 'block-q',
            status: 'pending',
            deployState: null,
            submittedAt: new Date('2026-02-01T00:00:00Z'),
            reviewedAt: null,
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Collapsed on the pending latest: no live badge, no Open live yet.
    await expect.element(page.getByText('pending', { exact: true })).toBeInTheDocument();
    expect(page.getByText('live', { exact: true }).elements()).toHaveLength(0);
    expect(page.getByRole('link', { name: /open live/i }).elements()).toHaveLength(0);

    // Expand to reveal v1 — the approved previous version is the live one.
    await page.getByRole('button', { name: /2 versions/i }).click();
    await expect.element(page.getByText('1.0.0', { exact: true })).toBeInTheDocument();
    expect(page.getByText('live', { exact: true }).elements()).toHaveLength(1);
    expect(page.getByRole('link', { name: /open live/i }).elements()).toHaveLength(1);
  });

  test('the published version shows NO "Open live" while its deploy is not live (building/failed)', async () => {
    // The newest-approved version is the "currently published" one by version logic,
    // but a failed/incomplete deploy means the slug 404s — the button must be hidden
    // so it never links to a dead URL nor contradicts the "deploy failed" badge.
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({
            id: 'only',
            version: '1.0.0',
            appBlockId: 'block-r',
            status: 'approved',
            deployState: 'failed',
            submittedAt: new Date('2026-03-01T00:00:00Z'),
          }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // Approved + currently-published, but deploy failed → no Open live, no "live" badge.
    expect(page.getByRole('link', { name: /open live/i }).elements()).toHaveLength(0);
    expect(page.getByText('live', { exact: true }).elements()).toHaveLength(0);
  });
});

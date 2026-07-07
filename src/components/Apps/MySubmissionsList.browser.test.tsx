import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import dayjs from '~/shared/utils/dayjs';
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
 *   4. The authoring affordance links the Civitai CLI (the git path is demoted
 *      to a collapsed "Advanced" footnote).
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

// AuthorViaGit provisions a Forgejo identity on mount — stub to a marker so the
// "Advanced: author via git" footnote is testable without that side-effect.
vi.mock('~/components/Apps/AuthorViaGit', () => ({
  AuthorViaGit: () => <div data-testid="author-via-git">git-panel</div>,
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

  test('the authoring affordance links the Civitai CLI (git demoted to an Advanced footnote)', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[makeSubmission({ appBlockId: 'block-1' })]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    // CLI link present + points at the CLI repo.
    const cliLink = page.getByRole('link', { name: /civitai.*CLI/i });
    await expect.element(cliLink).toBeInTheDocument();
    expect(cliLink.element().getAttribute('href')).toBe('https://github.com/civitai/cli');

    // Git is NOT a primary affordance — the panel is collapsed behind "Advanced".
    expect(page.getByTestId('author-via-git').elements()).toHaveLength(0);
    const advanced = page.getByRole('button', { name: /advanced.*git/i });
    await expect.element(advanced).toBeInTheDocument();
    await advanced.click();
    await expect.element(page.getByTestId('author-via-git')).toBeInTheDocument();
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

  test('clicking the App header sorts and exposes aria-sort', async () => {
    renderWithProviders(
      <MySubmissionsList
        submissions={[
          makeSubmission({ id: 'b', slug: 'bravo-app', appBlockId: 'block-b' }),
          makeSubmission({ id: 'a', slug: 'alpha-app', appBlockId: 'block-a' }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    const appHeader = page.getByRole('button', { name: /sort by app/i });
    await appHeader.click();
    // The header's <th> reflects the active sort for screen readers.
    const th = appHeader.element().closest('th');
    expect(th?.getAttribute('aria-sort')).toBe('ascending');
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
});

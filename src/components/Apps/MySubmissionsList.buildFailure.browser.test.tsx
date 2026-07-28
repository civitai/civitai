import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { DEPLOY_STALE_AFTER_MS } from '~/shared/constants/app-block-deploy.constants';

/**
 * /apps/my-submissions — the OWNER-FACING half of the build-failure fix.
 *
 * Two production defects are covered here:
 *
 *   A. A failed build showed only "Build Failed". The line that actually tells the
 *      author what to fix lived in a build log they cannot read. The excerpt now
 *      renders in a scroll-capped block — and it must render as TEXT, escaped,
 *      never as markup.
 *
 *   B. An approved request whose build never fired rendered a healthy green
 *      "approved" forever (the badge's `default` branch). It must now read as
 *      stranded — but ONLY past the stale threshold, so a freshly-approved row is
 *      byte-for-byte what it always was.
 */

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ blocks: { listMyPublishRequests: { invalidate: mocks.invalidate } } }),
    blocks: {
      getMyAppAnalytics: { useQuery: () => ({ data: undefined, isLoading: false }) },
      getMyApps: { useQuery: () => ({ data: [], isLoading: false }) },
      getMyAppRepo: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    appListings: {
      unpublishOwnListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      republishOwnListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      listMyListingModerationEvents: {
        useQuery: () => ({ data: { items: [], nextCursor: null }, isLoading: false, error: null }),
      },
    },
  },
  setTrpcBatchingEnabled: vi.fn(),
}));

vi.mock('~/components/AppBlocks/AppAnalyticsPanel', () => ({
  AppAnalyticsPanel: () => <div data-testid="analytics-panel" />,
}));

import type { Submission } from './MySubmissionsList';
const { MySubmissionsList } = await import('./MySubmissionsList');

const LONG_AGO = new Date(Date.now() - DEPLOY_STALE_AFTER_MS - 60_000);
const JUST_NOW = new Date(Date.now() - 5_000);

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 's1',
    appBlockId: 'block-1',
    slug: 'my-app',
    version: '1.0.0',
    status: 'approved',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedAt: LONG_AGO,
    rejectionReason: null,
    approvalNotes: null,
    deployState: 'live',
    deployDetail: null,
    deployUpdatedAt: LONG_AGO,
    fileSummary: {},
    manifestDiffSummary: {},
    modelInstallCount: 0,
    userSubscriptionCount: 0,
    appListingId: 'listing-1',
    listingStatus: 'approved',
    lastModerationAction: null,
    hasPage: true,
    ...overrides,
  };
}

function render(s: Submission) {
  renderWithProviders(
    <MySubmissionsList submissions={[s]} onWithdraw={vi.fn()} withdrawing={false} />
  );
}

beforeEach(() => {
  mocks.invalidate.mockClear();
});

describe('A — the real build-failure reason reaches the author', () => {
  const EXCERPT = 'ERROR: no package-lock.json is committed. Commit your lockfile.';

  test('renders the excerpt for a failed deploy', async () => {
    render(
      makeSubmission({
        deployState: 'failed',
        deployDetail: `Build Failed\n\n${EXCERPT}`,
      })
    );
    await expect
      .element(page.getByTestId('apps-submissions-failure-detail-my-app'))
      .toBeInTheDocument();
    await expect.element(page.getByText(EXCERPT, { exact: false })).toBeInTheDocument();
    // The "Build Failed" headline is still shown alongside it.
    await expect.element(page.getByText('Build Failed', { exact: false })).toBeInTheDocument();
  });

  test('renders the excerpt as ESCAPED TEXT, never as markup', async () => {
    // The excerpt is tenant-influenced. It is sanitized server-side to printable
    // text, but the renderer must ALSO escape — pin that a script-ish payload
    // becomes visible characters and creates no element.
    const hostile = 'error at <script>alert(1)</script> in <b>index.ts</b>';
    render(makeSubmission({ deployState: 'failed', deployDetail: `Build Failed\n\n${hostile}` }));
    const block = page.getByTestId('apps-submissions-failure-detail-my-app');
    await expect.element(block).toBeInTheDocument();
    const el = block.element();
    // The literal characters are present as TEXT...
    expect(el.textContent).toContain('<script>alert(1)</script>');
    expect(el.textContent).toContain('<b>index.ts</b>');
    // ...and no element was ever created from them.
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
  });

  test('preserves newlines in a multi-line excerpt', async () => {
    const multi = 'ERROR: build failed\n  at Object.<anonymous> (index.ts:3:9)\n  exit code 1';
    render(makeSubmission({ deployState: 'failed', deployDetail: `Build Failed\n\n${multi}` }));
    const block = page.getByTestId('apps-submissions-failure-detail-my-app');
    await expect.element(block).toBeInTheDocument();
    const el = block.element();
    expect(el.textContent).toContain('\n');
    expect(el.textContent).toContain('exit code 1');
    // pre-wrap is what makes those newlines visible rather than collapsed.
    expect(getComputedStyle(el).whiteSpace).toBe('pre-wrap');
  });

  test('the excerpt block is height-capped and scrolls — it cannot blow out the row', async () => {
    const huge = Array.from({ length: 400 }, (_, i) => `line ${i}: something went wrong`).join(
      '\n'
    );
    render(makeSubmission({ deployState: 'failed', deployDetail: `Build Failed\n\n${huge}` }));
    const block = page.getByTestId('apps-submissions-failure-detail-my-app');
    await expect.element(block).toBeInTheDocument();
    const el = block.element();
    const style = getComputedStyle(el);
    expect(style.overflow === 'auto' || style.overflowY === 'auto').toBe(true);
    // Rendered height stays bounded even with 400 lines of content.
    expect(el.getBoundingClientRect().height).toBeLessThan(400);
    expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
  });

  test('a failed deploy with NO excerpt shows the generic guidance (unchanged)', async () => {
    render(makeSubmission({ deployState: 'failed', deployDetail: null }));
    await expect
      .element(page.getByText(/fix the issue and resubmit a new version/i))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-submissions-failure-detail-my-app').elements()).toHaveLength(0);
  });

  test('a deployDetail with no excerpt renders the headline only, no code block', async () => {
    render(makeSubmission({ deployState: 'failed', deployDetail: 'Build Failed' }));
    await expect.element(page.getByText('Build Failed', { exact: false })).toBeInTheDocument();
    expect(page.getByTestId('apps-submissions-failure-detail-my-app').elements()).toHaveLength(0);
  });
});

describe('B — the STRANDED row stops masquerading as healthy', () => {
  test('an approved row with a null deploy state, long past approval, reads as stranded', async () => {
    render(makeSubmission({ deployState: null, deployUpdatedAt: null, reviewedAt: LONG_AGO }));
    // The BADGE text is exactly this — the row no longer wears a green "approved".
    await expect
      .element(page.getByText('build never started', { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByTestId('apps-submissions-stranded-my-app')).toBeInTheDocument();
    // And the healthy green badge is gone.
    expect(page.getByText('approved', { exact: true }).elements()).toHaveLength(0);
  });

  test('the stranded message tells the author to contact a moderator, NOT to resubmit', async () => {
    render(makeSubmission({ deployState: null, deployUpdatedAt: null, reviewedAt: LONG_AGO }));
    const banner = page.getByTestId('apps-submissions-stranded-my-app');
    await expect.element(banner).toBeInTheDocument();
    const alert = banner.element();
    expect(alert.textContent).toMatch(/contact a moderator/i);
    expect(alert.textContent).toMatch(/build never started/i);
    // The author must NOT be told to resubmit — only a moderator can fix this.
    expect(alert.textContent).not.toMatch(/resubmit/i);
  });

  test('DARK-SAFE: a FRESHLY-approved null-state row is unchanged (still plain "approved")', async () => {
    render(makeSubmission({ deployState: null, deployUpdatedAt: null, reviewedAt: JUST_NOW }));
    await expect.element(page.getByText('approved', { exact: true })).toBeInTheDocument();
    expect(page.getByText('build never started', { exact: true }).elements()).toHaveLength(0);
    expect(page.getByTestId('apps-submissions-stranded-my-app').elements()).toHaveLength(0);
  });

  test('DARK-SAFE: a LEGACY null-state row that once transitioned is unchanged', async () => {
    // Pre-feature approved rows can have a null state; if they carry a transition
    // timestamp the lifecycle DID run, so they must not be flagged.
    render(makeSubmission({ deployState: null, deployUpdatedAt: LONG_AGO, reviewedAt: LONG_AGO }));
    expect(page.getByText('build never started', { exact: true }).elements()).toHaveLength(0);
    expect(page.getByTestId('apps-submissions-stranded-my-app').elements()).toHaveLength(0);
  });

  test('a LIVE row is untouched by any of this', async () => {
    render(makeSubmission({ deployState: 'live' }));
    await expect.element(page.getByText('live', { exact: true })).toBeInTheDocument();
    expect(page.getByText('build never started', { exact: true }).elements()).toHaveLength(0);
    expect(page.getByTestId('apps-submissions-failure-detail-my-app').elements()).toHaveLength(0);
  });
});

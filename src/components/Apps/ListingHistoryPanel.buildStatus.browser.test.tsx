import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import { DEPLOY_STALE_AFTER_MS } from '~/shared/constants/app-block-deploy.constants';
import type { ListingHistoryEntry } from './ListingHistoryPanel';
import {
  BUILD_NONE_DETAIL,
  DEPLOY_TIMED_OUT_DETAIL,
  HOSTILE_DETAIL,
  HOSTILE_EXCERPT,
  NPM_TAIL_DETAIL,
  NPM_TAIL_EXCERPT,
  RECIPE_ERROR_DETAIL,
  RECIPE_ERROR_EXCERPT,
  SCAN_BLOCKED_DETAIL,
} from './__tests__/buildFailureFixtures';

/**
 * The listing's **History** tab, as the place an app's team learns whether an approved
 * version actually went live — and, when it did not, why and whose move it is.
 *
 * 🔴 WHY THIS EXISTS. The only author-facing failure UI was `MySubmissionsList`, which lost
 * its last route when `/apps/my-submissions` started redirecting. On the History tab a failed
 * build showed one dimmed word, `· failed`, while the real excerpt reached only the CLI. The
 * cases below re-point that component's build-failure suite here and add what it never had:
 * an honest headline for `Build None`, a cause that never defaults to the author, and elapsed
 * time while a build runs.
 *
 * Fixtures other than `HOSTILE_*` are values the server writes
 * (`__tests__/buildFailureFixtures.ts`). The clock is pinned through the view's `now` prop.
 * The `component` project loads no CSS, so layout claims here rest on inline styles only.
 */

const mocks = vi.hoisted(() => ({
  entries: [] as unknown[],
  /** The options object of every `listingHistory.useQuery` call. */
  queryOpts: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // Proxy-shaped: only the history read is measured; every other procedure is inert.
  trpc: makeTrpcProxy({
    'appListings.listingHistory': {
      useQuery: (_input: unknown, opts?: Record<string, unknown>) => {
        mocks.queryOpts.push(opts);
        return { data: mocks.entries, isLoading: false, error: null };
      },
    },
  }),
}));

const { ListingHistoryPanel, ListingHistoryPanelView, ListingHistoryEntryRow } = await import(
  './ListingHistoryPanel'
);

const NOW = Date.parse('2026-10-08T20:00:00Z');
const LONG_AGO = new Date(NOW - DEPLOY_STALE_AFTER_MS - 60_000);
const JUST_NOW = new Date(NOW - 5_000);

function version(over: Partial<ListingHistoryEntry> & { id: string }): ListingHistoryEntry {
  return {
    source: 'version',
    status: 'approved',
    version: '1.4.0',
    submittedAt: '2026-10-08T19:50:00Z',
    reviewedAt: new Date(NOW - 10 * 60_000),
    rejectionReason: null,
    approvalNotes: null,
    changelog: null,
    deployState: 'failed',
    deployUpdatedAt: new Date(NOW - 60_000),
    deployDetail: null,
    canWithdraw: false,
    ...over,
  };
}

function renderEntries(entries: ListingHistoryEntry[]) {
  renderWithProviders(<ListingHistoryPanelView entries={entries} now={NOW} />);
}

const failureBlock = (id: string) => page.getByTestId(`apps-history-failure-${id}`);
const excerptBlock = (id: string) => page.getByTestId(`apps-history-failure-${id}-excerpt`);

beforeEach(() => {
  mocks.entries = [];
  mocks.queryOpts = [];
});

describe('A — a failed version says what happened and whose move it is', () => {
  test('🔴 the security-scan failure (the incident shape) is NOT blamed on the author', async () => {
    renderEntries([version({ id: 'v_scan', deployDetail: SCAN_BLOCKED_DETAIL })]);
    const block = failureBlock('v_scan');
    await expect.element(block).toBeInTheDocument();
    await expect.element(block).toHaveTextContent(/Blocked by the security scan/);
    expect(block.element().getAttribute('data-failure-class')).toBe('security-scan');
    // The finding itself is shown.
    await expect.element(excerptBlock('v_scan')).toHaveTextContent(/SCAN-BLOCKED/);
    // 🔴 The two lies the incident told: a status that says nothing, and "resubmit".
    const text = page.getByTestId('apps-history-list').element().textContent ?? '';
    expect(text).not.toMatch(/Build None/);
    expect(text).not.toMatch(/submit a new version/i);
    // The chip names the cause instead of "deploy failed".
    await expect
      .element(page.getByTestId('apps-history-deploy-v_scan'))
      .toHaveTextContent(/blocked by security scan/);
  });

  test('a build pre-check ERROR is the author’s to fix, and says so', async () => {
    renderEntries([version({ id: 'v_lock', deployDetail: RECIPE_ERROR_DETAIL })]);
    const block = failureBlock('v_lock');
    await expect.element(block).toHaveTextContent(/a fix is needed in your app/);
    await expect.element(block).toHaveTextContent(/submit a new version/);
    expect(block.element().getAttribute('data-failure-class')).toBe('author');
    expect(excerptBlock('v_lock').element().textContent).toBe(RECIPE_ERROR_EXCERPT);
    await expect
      .element(page.getByTestId('apps-history-deploy-v_lock'))
      .toHaveTextContent(/build failed/);
  });

  test('🔴 "Build None" with no excerpt is UNKNOWN, worded neutrally — never "your code"', async () => {
    renderEntries([version({ id: 'v_none', deployDetail: BUILD_NONE_DETAIL })]);
    const block = failureBlock('v_none');
    await expect
      .element(block)
      .toHaveTextContent("We couldn't determine the cause — retry, or contact us if it repeats.");
    const text = page.getByTestId('apps-history-list').element().textContent ?? '';
    expect(text).not.toMatch(/Build None/);
    expect(text).not.toMatch(/your code/i);
    expect(text).not.toMatch(/submit a new version/i);
    expect(excerptBlock('v_none').elements()).toHaveLength(0);
  });

  test('an unrecognised log tail is unknown too, and the excerpt is still shown', async () => {
    renderEntries([version({ id: 'v_npm', deployDetail: NPM_TAIL_DETAIL })]);
    await expect
      .element(failureBlock('v_npm'))
      .toHaveTextContent("We couldn't determine the cause — retry, or contact us if it repeats.");
    expect(excerptBlock('v_npm').element().textContent).toBe(NPM_TAIL_EXCERPT);
  });

  test('a deploy timeout is ours: no excerpt, and no new version needed', async () => {
    renderEntries([version({ id: 'v_dto', deployDetail: DEPLOY_TIMED_OUT_DETAIL })]);
    const block = failureBlock('v_dto');
    await expect.element(block).toHaveTextContent(/deploy timed out/);
    await expect.element(block).toHaveTextContent(/don't need to submit a new version/);
    expect(excerptBlock('v_dto').elements()).toHaveLength(0);
    await expect
      .element(page.getByTestId('apps-history-deploy-v_dto'))
      .toHaveTextContent(/deploy failed/);
  });

  test('a failed row with NO detail (legacy) gets the neutral copy, not "fix and resubmit"', async () => {
    renderEntries([version({ id: 'v_null', deployDetail: null })]);
    const block = failureBlock('v_null');
    await expect.element(block).toHaveTextContent(/couldn't determine the cause/);
    expect(block.element().textContent).not.toMatch(/resubmit|submit a new version/i);
  });
});

describe('🔴 A — the excerpt is tenant bytes, rendered as literal text', () => {
  test('markup, a terminal escape and a 5000-char line render as characters, not elements', async () => {
    renderEntries([version({ id: 'v_bad', deployDetail: HOSTILE_DETAIL })]);
    const block = excerptBlock('v_bad');
    await expect.element(block).toBeInTheDocument();
    const el = block.element();
    // Every byte is there as TEXT…
    expect(el.textContent).toBe(HOSTILE_EXCERPT);
    // …and no element was created from any of it.
    expect(el.children).toHaveLength(0);
    expect(document.querySelector('[data-testid="apps-history-list"] script')).toBeNull();
    expect(document.querySelector('[data-testid="apps-history-list"] img')).toBeNull();
    // The long line wraps inside its box rather than widening the page.
    expect(getComputedStyle(el).overflowWrap).toBe('anywhere');
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
  });

  test('a multi-line excerpt keeps its newlines and is height-capped', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: something went wrong`);
    renderEntries([
      version({ id: 'v_long', deployDetail: `Build Failed\n\nERROR: first\n${lines.join('\n')}` }),
    ]);
    await expect.element(excerptBlock('v_long')).toBeInTheDocument();
    const el = excerptBlock('v_long').element();
    expect(el.textContent).toContain('\nline 399: something went wrong');
    const style = getComputedStyle(el);
    expect(style.whiteSpace).toBe('pre-wrap');
    expect(style.overflow === 'auto' || style.overflowY === 'auto').toBe(true);
    expect(el.getBoundingClientRect().height).toBeLessThan(400);
    expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
  });
});

describe('🔴 A — the excerpt never reaches the moderator surface', () => {
  /**
   * INVARIANT GUARD, not regression coverage: the moderator's prior-versions modal renders
   * the shared `ListingHistoryEntryRow`, which has never rendered a failure block. This pins
   * that the block stays in the author-only view even when the entry happens to carry a
   * detail (the moderator read never selects one).
   */
  test('the shared row alone renders no failure block, only the plain state', async () => {
    const e = version({ id: 'v_mod', deployDetail: RECIPE_ERROR_DETAIL });
    renderWithProviders(<ListingHistoryEntryRow entry={e} />);
    await expect
      .element(page.getByTestId('apps-history-entry-v_mod'))
      .toHaveTextContent(/· failed/);
    expect(failureBlock('v_mod').elements()).toHaveLength(0);
    expect(page.getByText(RECIPE_ERROR_EXCERPT, { exact: false }).elements()).toHaveLength(0);
  });
});

describe('B — a STRANDED version stops masquerading as healthy', () => {
  const stranded = (id: string, reviewedAt: Date, deployUpdatedAt: Date | null = null) =>
    version({ id, deployState: null, deployUpdatedAt, reviewedAt });

  test('approved long ago with no build ever started reads as stranded', async () => {
    renderEntries([stranded('v_str', LONG_AGO)]);
    await expect
      .element(page.getByTestId('apps-history-deploy-v_str'))
      .toHaveTextContent('build never started');
    const alert = page.getByTestId('apps-history-stranded-v_str');
    await expect.element(alert).toHaveTextContent(/contact a moderator/i);
    expect(alert.element().textContent).not.toMatch(/resubmit|submit a new version/i);
  });

  test('DARK-SAFE: a freshly approved null-state version is unchanged', async () => {
    renderEntries([stranded('v_new', JUST_NOW)]);
    await expect.element(page.getByTestId('apps-history-entry-v_new')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-stranded-v_new').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-history-deploy-v_new').elements()).toHaveLength(0);
  });

  test('DARK-SAFE: a legacy null-state version that once transitioned is unchanged', async () => {
    renderEntries([stranded('v_leg', LONG_AGO, LONG_AGO)]);
    await expect.element(page.getByTestId('apps-history-entry-v_leg')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-stranded-v_leg').elements()).toHaveLength(0);
  });
});

describe('C — a running build shows how long it has been going', () => {
  test('building for 2m 10s says so, with the usual range', async () => {
    renderEntries([
      version({ id: 'v_run', deployState: 'building', deployUpdatedAt: new Date(NOW - 130_000) }),
    ]);
    await expect
      .element(page.getByTestId('apps-history-elapsed-v_run'))
      .toHaveTextContent('2m 10s · usually 1–4 min');
    await expect
      .element(page.getByTestId('apps-history-deploy-v_run'))
      .toHaveTextContent(/building/);
  });

  test('a stalled build says it may be stuck — without telling the author to resubmit', async () => {
    renderEntries([
      version({ id: 'v_stuck', deployState: 'deploying', deployUpdatedAt: LONG_AGO }),
    ]);
    const chip = page.getByTestId('apps-history-deploy-v_stuck');
    await expect.element(chip).toHaveTextContent(/deploying \(stalled\)/);
    const tooltip = chip.element().querySelector('[title]')?.getAttribute('title') ?? '';
    expect(tooltip).toMatch(/may be stuck/);
    expect(tooltip).not.toMatch(/resubmit|submit a new version/i);
    expect(page.getByTestId('apps-history-elapsed-v_stuck').elements()).toHaveLength(0);
  });

  test('deploying shows elapsed time WITHOUT the whole-build range (its clock restarted)', async () => {
    renderEntries([
      version({ id: 'v_dep', deployState: 'deploying', deployUpdatedAt: new Date(NOW - 45_000) }),
    ]);
    const elapsed = page.getByTestId('apps-history-elapsed-v_dep');
    await expect.element(elapsed).toHaveTextContent('45s');
    expect(elapsed.element().textContent).not.toMatch(/usually/);
  });

  test('without a pinned clock the elapsed time moves on its own', async () => {
    mocks.entries = [
      version({
        id: 'v_tick',
        deployState: 'building',
        deployUpdatedAt: new Date(Date.now() - 5_000),
      }),
    ];
    renderWithProviders(<ListingHistoryPanel appListingId="apl_tick" />);
    const elapsed = page.getByTestId('apps-history-elapsed-v_tick');
    await expect.element(elapsed).toBeInTheDocument();
    const first = elapsed.element().textContent;
    // A state ARRIVING (a later reading), never one that leaves — see testing.md.
    await expect.poll(() => elapsed.element().textContent, { timeout: 5_000 }).not.toBe(first);
  });

  test('the history read polls while a version builds, and stops once nothing is in flight', async () => {
    mocks.entries = [
      version({ id: 'v_poll', deployState: 'building', deployUpdatedAt: new Date(Date.now()) }),
    ];
    renderWithProviders(<ListingHistoryPanel appListingId="apl_poll" />);
    await expect.element(page.getByTestId('apps-history-entry-v_poll')).toBeInTheDocument();
    const opts = mocks.queryOpts.at(-1);
    const interval = opts?.refetchInterval as (q: { state: { data: unknown } }) => number | false;
    expect(typeof interval).toBe('function');
    expect(interval({ state: { data: mocks.entries } })).toBe(5000);
    expect(interval({ state: { data: [version({ id: 'v_done', deployState: 'failed' })] } })).toBe(
      false
    );
    // A listing-edit entry is not a build, whatever it carries.
    expect(
      interval({
        state: {
          data: [version({ id: 'l_x', source: 'listing', deployState: 'building' })],
        },
      })
    ).toBe(false);
  });
});

describe('D — "live" belongs to the currently published version only', () => {
  test('the newest approved version is live; an older live one keeps the plain state', async () => {
    renderEntries([
      // A newer approved LISTING edit is not a version: it must not take the live chip.
      version({ id: 'l_edit', source: 'listing', deployState: null, version: null }),
      // A lifecycle value on a non-approved row must still not produce a chip.
      version({ id: 'v_pend', status: 'pending', deployState: 'building', version: '3.0.0' }),
      version({ id: 'v_cur', deployState: 'live', version: '2.0.0' }),
      version({ id: 'v_old', deployState: 'live', version: '1.0.0' }),
    ]);
    // All rows commit in one render, so read them synchronously: a misplaced chip fails by
    // name, not by timeout.
    await expect.element(page.getByTestId('apps-history-entry-v_old')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-deploy-v_cur').elements()).toHaveLength(1);
    expect(page.getByTestId('apps-history-deploy-v_cur').element().textContent).toBe('live');
    expect(page.getByTestId('apps-history-deploy-v_old').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-history-entry-v_old').element().textContent).toMatch(/· live/);
    expect(page.getByTestId('apps-history-deploy-v_pend').elements()).toHaveLength(0);
  });
});

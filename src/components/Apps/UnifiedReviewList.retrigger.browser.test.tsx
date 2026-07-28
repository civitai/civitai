import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { DEPLOY_STALE_AFTER_MS } from '~/shared/constants/app-block-deploy.constants';
import type { OffsitePendingRow } from './OffsiteReviewQueue';
import type { OnsiteReviewRequest } from './unifiedReviewRow';

/**
 * /apps/review APPROVED tab — the MODERATOR half of the fix.
 *
 * A production approval whose build never fired left `deploy_state` NULL forever.
 * In the mod queue that was indistinguishable from a healthy approval, and there
 * was no way to re-run the build (`approveRequest` is not idempotent), so the only
 * recovery was asking the developer to resubmit at a new version.
 *
 * These tests pin: the Deploy column surfaces the "never built" state; the
 * "Retrigger build" control appears and is enabled exactly where the server would
 * accept it; and a double-click cannot fire the mutation twice.
 */

const LONG_AGO = new Date(Date.now() - DEPLOY_STALE_AFTER_MS - 60_000);
const JUST_NOW = new Date(Date.now() - 30_000);

function onsiteRow(over: Partial<Record<string, unknown>> = {}): OnsiteReviewRequest {
  return {
    id: 'req-1',
    appBlockId: 'apb_1',
    slug: 'my-onsite',
    version: '1.0.0',
    submittedAt: '2026-01-01T00:00:00Z',
    reviewedAt: LONG_AGO,
    approvalNotes: null,
    reviewedBy: null,
    bundleSizeBytes: '10',
    bundleSha256: 'sha',
    manifest: { name: 'My Onsite App' },
    fileSummary: {},
    manifestDiffSummary: {},
    reviewRepoUrl: 'https://example.invalid/repo',
    submittedBy: { id: 7, username: 'onsite-dev', image: null },
    // The lifecycle projection `listApprovedRequests` now selects.
    deployState: null,
    deployDetail: null,
    deployUpdatedAt: null,
    ...over,
  } as unknown as OnsiteReviewRequest;
}

const { UnifiedReviewList } = await import('./UnifiedReviewList');

function renderApproved(opts: {
  row: OnsiteReviewRequest;
  onRetrigger?: (id: string) => void;
  retriggeringId?: string | null;
}) {
  renderWithProviders(
    <UnifiedReviewList
      onsiteItems={[opts.row]}
      offsiteItems={[]}
      direction="desc"
      openOnsiteReview={vi.fn()}
      openOffsiteReview={vi.fn() as unknown as (r: OffsitePendingRow) => void}
      isLoading={false}
      emptyLabel="empty"
      dateLabel="Reviewed"
      actionLabel="View"
      hasMore={false}
      onLoadMore={vi.fn()}
      onRetriggerBuild={opts.onRetrigger}
      retriggeringId={opts.retriggeringId ?? null}
    />
  );
}

const RETRIGGER = 'apps-unified-review-retrigger-onsite:req-1';
const DEPLOY_CHIP = 'apps-unified-review-deploy-onsite:req-1';

describe('Approved tab — the Deploy column exposes a stranded approval', () => {
  test('a null deploy state renders as "never built", not as a healthy approval', async () => {
    renderApproved({ row: onsiteRow(), onRetrigger: vi.fn() });
    const chip = page.getByTestId(DEPLOY_CHIP);
    await expect.element(chip).toBeInTheDocument();
    expect(chip.element().textContent).toMatch(/never built/i);
  });

  test('a live deploy renders its real state', async () => {
    renderApproved({
      row: onsiteRow({ deployState: 'live', deployUpdatedAt: LONG_AGO }),
      onRetrigger: vi.fn(),
    });
    const chip = page.getByTestId(DEPLOY_CHIP);
    await expect.element(chip).toBeInTheDocument();
    expect(chip.element().textContent).toMatch(/live/i);
  });

  test('the Deploy column and control are ABSENT when no handler is passed (Rejected tab)', async () => {
    renderApproved({ row: onsiteRow(), onRetrigger: undefined });
    // The row still renders...
    await expect.element(page.getByTestId('apps-unified-review-row-onsite:req-1')).toBeInTheDocument();
    // ...with no Deploy column and no retrigger control.
    expect(page.getByTestId(DEPLOY_CHIP).elements()).toHaveLength(0);
    expect(page.getByTestId(RETRIGGER).elements()).toHaveLength(0);
    expect(page.getByText('Deploy', { exact: true }).elements()).toHaveLength(0);
  });
});

describe('Approved tab — the Retrigger control follows the server gate', () => {
  test('ENABLED for a stranded (null-state) approval', async () => {
    renderApproved({ row: onsiteRow(), onRetrigger: vi.fn() });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(false);
  });

  test('ENABLED for a failed build', async () => {
    renderApproved({
      row: onsiteRow({ deployState: 'failed', deployUpdatedAt: JUST_NOW }),
      onRetrigger: vi.fn(),
    });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(false);
  });

  test('DISABLED for a live deploy — nothing to recover', async () => {
    renderApproved({
      row: onsiteRow({ deployState: 'live', deployUpdatedAt: LONG_AGO }),
      onRetrigger: vi.fn(),
    });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(true);
  });

  test('DISABLED for a build that is still genuinely in flight', async () => {
    renderApproved({
      row: onsiteRow({ deployState: 'building', deployUpdatedAt: JUST_NOW }),
      onRetrigger: vi.fn(),
    });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(true);
  });

  test('ENABLED once an in-flight build has stalled past the shared threshold', async () => {
    renderApproved({
      row: onsiteRow({ deployState: 'building', deployUpdatedAt: LONG_AGO }),
      onRetrigger: vi.fn(),
    });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Approved tab — the control cannot double-fire', () => {
  test('requires a CONFIRM click, then fires ONCE with the publish-request id', async () => {
    const onRetrigger = vi.fn();
    renderApproved({ row: onsiteRow(), onRetrigger });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();

    // First click ARMS — it must not fire the mutation.
    await btn.click();
    expect(onRetrigger).not.toHaveBeenCalled();
    expect(btn.element().textContent).toMatch(/confirm/i);

    // Second click fires, exactly once, with only the request id.
    await btn.click();
    expect(onRetrigger).toHaveBeenCalledTimes(1);
    expect(onRetrigger).toHaveBeenCalledWith('req-1');
  });

  test('a rapid DOUBLE-CLICK arms then fires ONCE — never twice', async () => {
    const onRetrigger = vi.fn();
    renderApproved({ row: onsiteRow(), onRetrigger });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    await btn.dblClick();
    expect(onRetrigger).toHaveBeenCalledTimes(1);
  });

  test('is disabled while ITS OWN mutation is in flight', async () => {
    const onRetrigger = vi.fn();
    renderApproved({ row: onsiteRow(), onRetrigger, retriggeringId: 'req-1' });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(true);
  });

  test('another row in flight does NOT disable this row', async () => {
    const onRetrigger = vi.fn();
    renderApproved({ row: onsiteRow(), onRetrigger, retriggeringId: 'some-other-request' });
    const btn = page.getByTestId(RETRIGGER);
    await expect.element(btn).toBeInTheDocument();
    expect((btn.element() as HTMLButtonElement).disabled).toBe(false);
  });
});

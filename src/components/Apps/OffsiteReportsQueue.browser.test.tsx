import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * /apps/review reports queue — the `ReportActionModal` now routes its reason field +
 * submit through the shared {@link ReasonGatedActionModal} (B3), so delist / relist /
 * claim / purge get the SAME live counter + inline error + disabled-with-Tooltip gate
 * the reject paths have (finding A). resolve / dismiss keep the OPTIONAL note (no gate).
 * Browser-mode (report-only in Tekton): the gate + the fired mutations.
 */

const REPORT = {
  id: 'rep-1',
  appListingId: 'listing-9',
  reason: 'impersonation',
  details: 'copies another app',
  status: 'pending',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null,
  reporter: { id: 5, username: 'reporter', image: null },
  // `removed` listing → relist + claim + purge (+ resolve/dismiss for a pending report).
  appListing: { slug: 'bad-app', name: 'Bad App', kind: 'offsite', status: 'removed' },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        if (mocks.errorMode) opts?.onError?.({ message: 'boom' });
        else void opts?.onSuccess?.();
      },
      mutateAsync: vi.fn(),
      isPending: false,
    });
  return {
    trpc: {
      useUtils: () => ({
        appListings: { listListingReports: { invalidate: mocks.invalidate } },
      }),
      appListings: {
        listListingReports: {
          useQuery: () => ({
            data: { items: [REPORT], nextCursor: null },
            isLoading: false,
            isFetching: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        listModerationEvents: {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
        delistListing: { useMutation: mutation('delist') },
        relistListing: { useMutation: mutation('relist') },
        claimListing: { useMutation: mutation('claim') },
        purgeListing: { useMutation: mutation('purge') },
        resolveReport: { useMutation: mutation('resolve') },
        dismissReport: { useMutation: mutation('dismiss') },
      },
    },
  };
});

const { OffsiteReportsQueue } = await import('./OffsiteReviewQueue');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.errorMode = false;
});

describe('OffsiteReportsQueue — reason-gated report actions (finding A)', () => {
  test('Relist shows the live counter + inline error, disables under the floor, then fires', async () => {
    renderWithProviders(<OffsiteReportsQueue />);
    await page.getByTestId('apps-report-relist-bad-app').click();
    // The gate UX now matches the reject paths.
    await expect.element(page.getByText('0/3 characters minimum')).toBeInTheDocument();
    const confirm = page.getByTestId('apps-report-action-confirm');
    await expect.element(confirm).toBeDisabled();

    await page.getByTestId('apps-report-action-reason').fill('ab');
    await expect.element(page.getByText('2/3 characters minimum')).toBeInTheDocument();
    await expect.element(page.getByText('Enter at least 3 characters.')).toBeInTheDocument();
    await expect.element(confirm).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    await page.getByTestId('apps-report-action-reason').fill('takedown was wrong');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('relist', {
      appListingId: 'listing-9',
      reason: 'takedown was wrong',
    });
  });

  test('Purge is destructive (red "Purge permanently"), counter-gated, then fires', async () => {
    renderWithProviders(<OffsiteReportsQueue />);
    await page.getByTestId('apps-report-purge-bad-app').click();
    await expect.element(page.getByText('0/3 characters minimum')).toBeInTheDocument();
    const confirm = page.getByTestId('apps-report-action-confirm');
    await expect.element(confirm).toHaveTextContent('Purge permanently');
    await expect.element(confirm).toBeDisabled();

    await page.getByTestId('apps-report-action-reason').fill('malware payload');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('purge', {
      appListingId: 'listing-9',
      reason: 'malware payload',
    });
  });

  test('Claim is gated on BOTH a valid target and a ≥3 reason', async () => {
    renderWithProviders(<OffsiteReportsQueue />);
    await page.getByTestId('apps-report-claim-bad-app').click();
    const confirm = page.getByTestId('apps-report-action-confirm');
    await expect.element(confirm).toBeDisabled();
    // Reason alone (no target) stays disabled.
    await page.getByTestId('apps-report-action-reason').fill('verified real owner');
    await expect.element(confirm).toBeDisabled();
    await page.getByTestId('apps-report-claim-target').fill('777');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('claim', {
      appListingId: 'listing-9',
      targetUserId: 777,
      reason: 'verified real owner',
      reportId: 'rep-1',
    });
  });

  test('Resolve is an OPTIONAL note — enabled with no reason, no counter, fires resolveReport', async () => {
    renderWithProviders(<OffsiteReportsQueue />);
    await page.getByTestId('apps-report-resolve-bad-app').click();
    // No reason floor for a note → no counter, and the confirm is immediately enabled.
    expect(page.getByText('0/3 characters minimum').elements()).toHaveLength(0);
    const confirm = page.getByTestId('apps-report-action-confirm');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('resolve', { reportId: 'rep-1', note: undefined });
  });
});

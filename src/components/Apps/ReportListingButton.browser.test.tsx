import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 P3b — the off-site listing REPORT modal. Browser-mode surface test
 * (report-only in Tekton): the Report button opens a modal that renders the 6
 * schema reasons + submits the picked reason via `appListings.reportListing`.
 *
 * Network-free: the reportListing mutation + useCurrentUser + notifications are
 * mocked. The blocking correctness gate for the reason options lives in the node
 * `unit` project (`appListingReportView.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    appListings: {
      reportListing: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: mocks.isPending }),
      },
    },
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 42, username: 'viewer' }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ReportListingButton } = await import('./ReportListingButton');

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.isPending = false;
});

describe('ReportListingButton', () => {
  test('opens the modal and renders the 6 report reasons', async () => {
    renderWithProviders(<ReportListingButton appListingId="apl_target" />);
    await page.getByRole('button', { name: 'Report' }).click();

    await expect
      .element(page.getByText('Impersonation — not the real app or owner'))
      .toBeInTheDocument();
    await expect.element(page.getByText('Phishing or malware')).toBeInTheDocument();
    await expect.element(page.getByText('Broken — does not work')).toBeInTheDocument();
    await expect.element(page.getByText('Inappropriate content')).toBeInTheDocument();
    await expect.element(page.getByText('Spam')).toBeInTheDocument();
    await expect.element(page.getByText('Something else')).toBeInTheDocument();
  });

  test('submitting without a reason surfaces an inline error (mutation NOT called)', async () => {
    renderWithProviders(<ReportListingButton appListingId="apl_target" />);
    await page.getByRole('button', { name: 'Report' }).click();
    await page.getByRole('button', { name: 'Submit report' }).click();
    await expect.element(page.getByText('Please choose a reason.')).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('picking a reason + submitting calls reportListing with the listing id + reason', async () => {
    renderWithProviders(<ReportListingButton appListingId="apl_target" />);
    await page.getByRole('button', { name: 'Report' }).click();
    await page.getByRole('radio', { name: 'Spam' }).click();
    await page.getByRole('button', { name: 'Submit report' }).click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toMatchObject({
      appListingId: 'apl_target',
      reason: 'spam',
    });
  });
});

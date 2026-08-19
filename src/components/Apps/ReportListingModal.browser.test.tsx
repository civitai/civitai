import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

/**
 * W13 P3b — the off-site listing REPORT modal. Browser-mode surface test
 * (report-only in Tekton): the modal renders the 6 schema reasons + submits the
 * picked reason via `appListings.reportListing`.
 *
 * 🔴 THIS FILE USED TO DRIVE `ReportListingButton`, a self-contained button that
 * NOTHING in the app rendered — so these three tests were the component's only
 * consumer. The button is gone (its "already reported" state moved into
 * `useReportListingAffordance`, which the live `⋮` menu on the listing detail
 * page now uses); the modal itself is unchanged, so the tests are retargeted at
 * it directly and simply mount it `opened`. The live trigger → modal → spent
 * trigger path is covered in `AppListingDetailBody.browser.test.tsx`, and the
 * blocking wiring gate is `__tests__/appListingReportCallSites.test.ts` in the
 * node `unit` project.
 *
 * Network-free: the reportListing mutation + useCurrentUser + notifications are
 * mocked. The blocking correctness gate for the reason options lives in the node
 * `unit` project (`appListingReportView.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-
// mock): a hand-written replacement silently breaks every importer the day
// '~/utils/trpc' grows an export this factory omits — as 0 collected tests, not as a
// failure.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
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

const { ReportListingModal } = await import('./ReportListingModal');

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.isPending = false;
});

/** The modal renders no trigger — the caller owns `opened`. Mount it open. */
function renderOpenModal() {
  renderWithProviders(
    <ReportListingModal appListingId="apl_target" opened onClose={() => undefined} />
  );
}

describe('ReportListingModal', () => {
  test('opens the modal and renders the 6 report reasons', async () => {
    renderOpenModal();

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
    renderOpenModal();
    await page.getByRole('button', { name: 'Submit report' }).click();
    await expect.element(page.getByText('Please choose a reason.')).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('picking a reason + submitting calls reportListing with the listing id + reason', async () => {
    renderOpenModal();
    await page.getByRole('radio', { name: 'Spam' }).click();
    await page.getByRole('button', { name: 'Submit report' }).click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toMatchObject({
      appListingId: 'apl_target',
      reason: 'spam',
    });
  });
});

import { Notifications, notifications } from '@mantine/notifications';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The review page's sticky action bar against a toast from anything else on the page, in the
 * real cascade: the bar publishes how much of the viewport bottom it covers, and the bottom
 * notification containers are lifted above it (`globals.css`), so no such toast lands on Approve.
 */

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({}),
}));

const { ReviewActionBar } = await import('./ReviewActionBar');

const PENDING = {
  id: 'req-geometry',
  appBlockId: null,
  slug: 'my-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abc',
  manifest: { name: 'My Block', scopes: [] },
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: [] },
  reviewRepoUrl: null,
  pushCommitUrl: null,
  submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
};

const RESERVE = '--review-action-bar-reserve';
const DESKTOP = { width: 1124, height: 900 };

afterEach(() => {
  notifications.clean();
});

describe('the sticky review bar keeps bottom toasts off its buttons', () => {
  test('🔴 a bottom-right toast rests above the bar; without the reserve it lands on it', async () => {
    const view = await renderAtViewport(
      <>
        <Notifications />
        {/* A long review, so the bar is stuck to the viewport bottom as on the page. */}
        <div style={{ height: 3000 }} />
        <ReviewActionBar
          selection={{ request: PENDING as never, mode: 'pending' }}
          onClose={vi.fn()}
          sticky
          approveAndNext
        />
      </>,
      DESKTOP
    );
    const bar = page.getByTestId('apps-review-action-bar');
    await expect.element(bar).toBeInTheDocument();
    notifications.show({ id: 'other', message: 'Something else happened', autoClose: false });
    await expect.element(page.getByText('Something else happened')).toBeInTheDocument();
    // Past the enter transition, so the toast is measured where it rests.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await nextLayout();
    const container = () =>
      document.querySelector('.mantine-Notifications-root[data-position="bottom-right"]')!;
    const barBox = box(bar.element());
    // The bar really is at the viewport bottom, so the toast could cover it.
    expect(barBox.bottom).toBeGreaterThan(DESKTOP.height - 5);
    expect(box(container()).bottom).toBeLessThanOrEqual(barBox.top);

    // POSITIVE CONTROL: the same toast without the reserve overlaps the bar.
    const reserve = document.documentElement.style.getPropertyValue(RESERVE);
    document.documentElement.style.removeProperty(RESERVE);
    await nextLayout();
    expect(box(container()).bottom).toBeGreaterThan(barBox.top);
    document.documentElement.style.setProperty(RESERVE, reserve);

    // NEGATIVE CONTROL: once the bar is gone, nothing is reserved.
    await (await view.result).unmount();
    expect(document.documentElement.style.getPropertyValue(RESERVE)).toBe('');
  });
});

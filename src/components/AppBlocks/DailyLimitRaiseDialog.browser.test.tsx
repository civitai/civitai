import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as DialogStoreMod from '~/components/Dialog/dialogStore';

/**
 * The host's raise dialog itself: it shows the viewer's own numbers, sends only the value the
 * viewer chose, and its confirm stays disabled through the arm delay so a click aimed at the app
 * underneath cannot raise the limit.
 */

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), onClose: vi.fn() }));

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, zIndex: 200 }),
  useDialogId: () => 'block-daily-limit-apb_test',
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreMod>()),
  useIsTopDialog: () => true,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'blocks.raiseAppDailyLimit': {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    }),
  };
});

const { default: DailyLimitRaiseDialog } = await import('./DailyLimitRaiseDialog');

const confirm = () => page.getByTestId('block-daily-limit-raise-confirm');
const input = () => page.getByTestId('block-daily-limit-raise-input');

function mount(props: { limit?: number; spentToday?: number } = {}) {
  renderWithProviders(
    <DailyLimitRaiseDialog
      appBlockId="apb_test"
      appName="Live Gen"
      limit={props.limit ?? 1000}
      spentToday={props.spentToday ?? 980}
    />
  );
}

describe('DailyLimitRaiseDialog', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.onClose.mockReset();
  });

  test('shows the limit and today’s spend, and pre-fills twice the limit', async () => {
    mount();
    await expect.element(page.getByText(/limit of 1,000 Buzz a day/)).toBeVisible();
    await expect.element(page.getByText(/980 has been spent today/)).toBeVisible();
    await expect.element(input()).toHaveValue('2,000');
  });

  test('confirm is disabled through the arm delay, then raises to the value shown', async () => {
    mount();
    await expect.element(confirm()).toBeDisabled();
    await expect.element(confirm()).toBeEnabled({ timeout: 3000 });
    await userEvent.click(confirm());
    expect(mocks.mutate).toHaveBeenCalledWith({ appBlockId: 'apb_test', buzzBudgetPerDay: 2000 });
  });

  test('a value at or below the current limit cannot be sent', async () => {
    mount();
    await userEvent.clear(input());
    await userEvent.type(input(), '900');
    // Past the arm delay, so only the value can be what keeps it disabled.
    await new Promise((r) => setTimeout(r, 1300));
    await expect.element(confirm()).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('"Not now" has the initial focus and closes without raising', async () => {
    mount();
    const notNow = page.getByRole('button', { name: 'Not now' });
    await expect.element(notNow).toHaveFocus();
    await userEvent.click(notNow);
    expect(mocks.onClose).toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('at the highest limit there is nothing to raise', async () => {
    mount({ limit: 50_000, spentToday: 50_000 });
    await expect.element(page.getByText(/already the highest daily limit/)).toBeVisible();
    expect(confirm().query()).toBeNull();
  });
});

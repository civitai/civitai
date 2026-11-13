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

type MutationOpts = { onSuccess: () => Promise<void>; onError: (e: { message: string }) => void };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onClose: vi.fn(),
  onRaised: vi.fn(),
  invalidateLimit: vi.fn(),
  isTopMost: true,
  mutationOpts: null as unknown as MutationOpts,
}));

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, zIndex: 200 }),
  useDialogId: () => 'block-daily-limit-apb_test',
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreMod>()),
  useIsTopDialog: () => mocks.isTopMost,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'blocks.raiseAppDailyLimit': {
          useMutation: (opts: MutationOpts) => {
            mocks.mutationOpts = opts;
            return { mutate: mocks.mutate, isPending: false };
          },
        },
      },
      {
        useUtils: () => ({
          blocks: {
            getMyAppDailyLimit: { invalidate: mocks.invalidateLimit },
            listMyScopeGrants: { invalidate: vi.fn() },
          },
        }),
      }
    ),
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
      onRaised={mocks.onRaised}
    />
  );
}

describe('DailyLimitRaiseDialog', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.onClose.mockReset();
    mocks.onRaised.mockReset();
    mocks.invalidateLimit.mockReset();
    mocks.isTopMost = true;
  });

  test('shows the limit and today’s spend, and pre-fills twice the limit', async () => {
    mount();
    await expect.element(page.getByText(/limit of 1,000 Buzz a day/)).toBeVisible();
    await expect.element(page.getByText(/980 has been spent today/)).toBeVisible();
    await expect.element(input()).toHaveValue('2,000');
  });

  test('raises to the value shown, then reports the raise, refreshes the limit and closes', async () => {
    mocks.mutate.mockImplementation(() => mocks.mutationOpts.onSuccess());
    mount();
    await expect.element(confirm()).toBeEnabled({ timeout: 3000 });
    await userEvent.click(confirm());
    expect(mocks.mutate).toHaveBeenCalledWith({ appBlockId: 'apb_test', buzzBudgetPerDay: 2000 });
    await vi.waitFor(() => expect(mocks.onClose).toHaveBeenCalledTimes(1));
    expect(mocks.onRaised).toHaveBeenCalledTimes(1);
    // The host reads the outcome when the dialog closes, so the raise must be reported first.
    expect(mocks.onRaised.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onClose.mock.invocationCallOrder[0]
    );
    expect(mocks.invalidateLimit).toHaveBeenCalledWith({ appBlockId: 'apb_test' });
  });

  test('a refused raise shows the server message and does not report a raise', async () => {
    mocks.mutate.mockImplementation(() =>
      mocks.mutationOpts.onError({ message: 'Your limit for this app changed.' })
    );
    mount();
    await expect.element(confirm()).toBeEnabled({ timeout: 3000 });
    await userEvent.click(confirm());
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Your limit for this app changed.');
    expect(mocks.onRaised).not.toHaveBeenCalled();
    expect(mocks.onClose).not.toHaveBeenCalled();
  });

  test('confirm never arms while another dialog is on top', async () => {
    mocks.isTopMost = false;
    mount();
    // Past the arm delay, so only the dialog above it can be what keeps it disabled.
    await new Promise((r) => setTimeout(r, 1300));
    await expect.element(confirm()).toBeDisabled();
  });

  test('a value equal to the current limit cannot be sent', async () => {
    mount();
    await userEvent.clear(input());
    await userEvent.type(input(), '1000');
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

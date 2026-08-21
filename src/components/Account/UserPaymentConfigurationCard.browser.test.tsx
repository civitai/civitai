import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The Tipalti half of the account payments card. The status copy is driven by a plain text
 * column that stores Tipalti's own spelling, so these cases pin the two failure modes the card
 * has actually shipped: mounting for nobody who has an account, and telling a creator mid-
 * onboarding that their account cannot be set up.
 */

const mocks = vi.hoisted(() => ({
  config: {
    userPaymentConfiguration: undefined as Record<string, unknown> | undefined,
    isLoading: false,
  },
}));

vi.mock('~/components/UserPaymentConfiguration/util', () => ({
  useUserPaymentConfiguration: () => mocks.config,
  useTipaltiConfigurationUrl: () => ({ tipaltiConfigurationUrl: undefined, isLoading: false }),
}));

import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';

function withConfig(overrides: Record<string, unknown>) {
  mocks.config.userPaymentConfiguration = {
    userId: 1,
    stripeAccountId: null,
    tipaltiAccountId: 'payee-1',
    tipaltiAccountStatus: 'Active',
    tipaltiPaymentsEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.config.userPaymentConfiguration = undefined;
  mocks.config.isLoading = false;
});

describe('UserPaymentConfigurationCard — Tipalti', () => {
  test('renders the status for a creator who HAS a Tipalti account', async () => {
    withConfig({});
    renderWithProviders(<UserPaymentConfigurationCard />);

    await expect.element(page.getByText(/ready for withdrawals/i)).toBeInTheDocument();
  });

  test('an activated but not-yet-payable account gets the "activated, cannot withdraw" copy', async () => {
    withConfig({ tipaltiPaymentsEnabled: false });
    renderWithProviders(<UserPaymentConfigurationCard />);

    await expect
      .element(page.getByText(/activated but you are still not able to withdraw/i))
      .toBeInTheDocument();
  });

  test('PendingOnboarding reads as "requires setup", never as "unable to setup"', async () => {
    withConfig({ tipaltiAccountStatus: 'PendingOnboarding', tipaltiPaymentsEnabled: false });
    renderWithProviders(<UserPaymentConfigurationCard />);

    await expect.element(page.getByText(/Your account requires setup/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/unable to setup your account/i);
  });

  test.each([['Blocked'], ['BlockedByProvider']])(
    '%s hides the setup button and explains the account is unusable',
    async (status) => {
      withConfig({ tipaltiAccountStatus: status, tipaltiPaymentsEnabled: false });
      renderWithProviders(<UserPaymentConfigurationCard />);

      await expect.element(page.getByText(/unable to setup your account/i)).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/Set up my Tipalti Account/i);
    }
  );

  test('a creator without a Tipalti account still sees the invitation copy', async () => {
    withConfig({ tipaltiAccountId: null });
    renderWithProviders(<UserPaymentConfigurationCard />);

    await expect.element(page.getByText(/rolling invitations to Tipalti/i)).toBeInTheDocument();
  });
});

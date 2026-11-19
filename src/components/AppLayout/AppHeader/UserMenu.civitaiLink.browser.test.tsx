import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
vi.mock('~/components/BrowsingMode/BrowsingMode', () => ({
  BrowsingModeIcon: () => null,
  BrowsingModeMenu: () => null,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useBrowsingSettings: (select: (s: object) => unknown) => select({ showNsfw: false }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAppContext: () => ({
    settings: {},
    navBanners: [],
    domain: { green: true, blue: false, red: false },
    serverDomains: { green: 'civitai.com', red: 'civitai.red', blue: 'civitai.com' },
  }),
  useServerDomains: () => ({ green: 'civitai.com', red: 'civitai.red', blue: 'civitai.com' }),
}));
vi.mock('~/components/CivitaiWrapped/AccountProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAccountContext: () => ({ accounts: [], swapAccount: vi.fn(), removeAccount: vi.fn() }),
}));
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const { state } = vi.hoisted(() => ({ state: { buzzSpendPop: false } }));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'tester', isModerator: false }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canWrite: true, userMenuV2: false, buzzSpendPop: state.buzzSpendPop }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(),
}));

import { UserMenu } from '~/components/AppLayout/AppHeader/UserMenu';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';

beforeEach(() => {
  document.body.innerHTML = '';
});

// A signed-in user reaches the Link dialog through exactly one menu row, whatever buzzSpendPop says:
// the phone shortcuts used to carry their own Link row for buzzSpendPop users.
describe.each([false, true])('legacy user menu, buzzSpendPop %s', (buzzSpendPop) => {
  test('lists Civitai Link exactly once', async () => {
    state.buzzSpendPop = buzzSpendPop;
    renderWithProviders(
      <ContainerProvider containerName="main">
        <UserMenu />
      </ContainerProvider>
    );
    await userEvent.click(page.getByLabelText(/Account menu/));
    await expect.element(page.getByText('Download Link App').first()).toBeInTheDocument();
    expect(page.getByText('Civitai Link', { exact: true }).elements()).toHaveLength(1);
  });
});

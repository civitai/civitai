import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const CREATOR_MASK = 11492205;

const keys = [
  {
    id: 1,
    name: 'creator key',
    tokenScope: CREATOR_MASK,
    buzzLimit: null,
    createdAt: new Date(),
    lastUsedAt: null,
  },
  {
    id: 2,
    name: 'ai key',
    tokenScope: TokenScopePresets.AIServices,
    buzzLimit: null,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: new Date('2099-03-04T12:00:00Z'),
  },
  {
    id: 3,
    name: 'legacy key',
    tokenScope: null,
    buzzLimit: null,
    createdAt: new Date(),
    lastUsedAt: null,
  },
];

vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: {}, pathname: '/', replace: vi.fn() }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'apiKey.getAllUserKeys': { useQuery: () => ({ data: keys, isLoading: false }) },
    'apiKey.add': {
      useMutation: () => ({ data: undefined, isPending: false, mutate: vi.fn(), reset: vi.fn() }),
    },
  }),
}));

import { ApiKeyModal } from '~/components/Account/ApiKeyModal';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

describe('API key generation hints', () => {
  test('preset picker shows the generation hint', async () => {
    renderWithProviders(<ApiKeyModal opened onClose={vi.fn()} />);
    await expect
      .element(page.getByText(/needs the "AI Services" or "Full Access" preset/))
      .toBeVisible();
    await expect.element(page.getByText(/"Creator" or "Read Only" can.t generate/)).toBeVisible();
  });

  test('Creator mask is the Creator preset (fixture guard)', () => {
    // The fixture is a tRPC value (a JSON number); the preset is a bigint.
    expect(BigInt(CREATOR_MASK)).toBe(TokenScopePresets.Creator);
    expect(BigInt(CREATOR_MASK) & TokenScope.AIServicesWrite).toBe(0n);
  });

  test('key rows: Creator can’t generate; AI Services and legacy (null) can', async () => {
    renderWithProviders(<ApiKeysCard />);
    const markers = page.getByTestId('api-key-generation-marker');
    await expect.element(markers.nth(0)).toHaveTextContent(/can.t generate/i);
    await expect.element(markers.nth(1)).toHaveTextContent(/^can generate$/i);
    await expect.element(markers.nth(2)).toHaveTextContent(/^can generate$/i);
  });

  test('a key with an expiry shows it; a key without one shows none', async () => {
    renderWithProviders(<ApiKeysCard />);
    await expect.element(page.getByText(/^Expires /)).toHaveTextContent(/2099/);
    expect(page.getByText(/^Expires /).elements()).toHaveLength(1);
  });
});

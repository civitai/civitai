import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as Notifications from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Revoking a connected app also withdraws the App Store items its platform listed under the
 * user's name: the confirmation says how many, and a failed withdraw is reported.
 */

const { state, notify, setData, invalidate } = vi.hoisted(() => ({
  state: { revokeResult: { success: true, catalogItemsWithdrawn: 2 as number | null } },
  notify: { success: vi.fn(), error: vi.fn() },
  setData: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: notify.error,
  showSuccessNotification: notify.success,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'oauthConsent.getConnectedApps': {
          useQuery: () => ({
            data: [
              {
                clientId: 'client-games',
                name: 'Games Site',
                description: null,
                logoUrl: null,
                isVerified: false,
                scope: 1,
                buzzLimit: null,
                authorizedAt: new Date('2026-09-01T00:00:00Z'),
              },
            ],
            isLoading: false,
          }),
        },
        'oauthConsent.revokeApp': {
          useMutation: (opts: {
            onSuccess: (result: unknown, vars: { clientId: string }) => void;
          }) => ({
            mutate: (vars: { clientId: string }) => opts.onSuccess(state.revokeResult, vars),
            isPending: false,
          }),
        },
        'apiKey.getSpend': { useQuery: () => ({ data: [] }) },
        'appListings.listMyCatalogSubListings': {
          useQuery: () => ({
            data: {
              items: [
                item('asl_A', 'approved', 'client-games', false),
                item('asl_B', 'pending', 'client-games', false),
                item('asl_C', 'withdrawn', 'client-games', false),
                item('asl_D', 'approved', 'client-games', true),
                item('asl_E', 'approved', 'client-other', false),
              ],
            },
          }),
        },
      },
      {
        useUtils: () => ({
          oauthConsent: { getConnectedApps: { invalidate } },
          appListings: { listMyCatalogSubListings: { setData, invalidate } },
        }),
      }
    ),
  };
});

function item(id: string, status: string, clientId: string, isYours: boolean) {
  return {
    id,
    externalId: id,
    title: id,
    status,
    pendingEdit: false,
    statusReason: null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    href: null,
    parent: { id: 'apl_X', slug: 'x', name: 'X', clientId, isYours },
  };
}

import { ModalsProvider } from '@mantine/modals';
import { ConnectedAppsCard } from '~/components/Account/ConnectedAppsCard';

async function revoke() {
  await renderWithProviders(
    <ModalsProvider>
      <ConnectedAppsCard />
    </ModalsProvider>
  );
  await userEvent.click(page.getByTitle('Revoke access'));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.revokeResult = { success: true, catalogItemsWithdrawn: 2 };
});

describe('ConnectedAppsCard revoke and catalog items', () => {
  test("the confirmation counts the app's active items not under the user's own listing", async () => {
    await revoke();
    await expect
      .element(page.getByText(/It also withdraws the 2 App Store items it listed under your name/))
      .toBeInTheDocument();
  });

  test('after a revoke that withdrew items, marks them withdrawn in the list', async () => {
    await revoke();
    await userEvent.click(page.getByRole('button', { name: 'Revoke Access', exact: true }));
    expect(notify.success).toHaveBeenCalledWith({ message: 'App access revoked' });
    expect(notify.error).not.toHaveBeenCalled();
    expect(setData).toHaveBeenCalledTimes(1);
  });

  test('reports a withdraw that failed, and refetches the list', async () => {
    state.revokeResult = { success: true, catalogItemsWithdrawn: null };
    await revoke();
    await userEvent.click(page.getByRole('button', { name: 'Revoke Access', exact: true }));
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0][0]).toMatchObject({ title: 'App access revoked' });
    expect(notify.success).not.toHaveBeenCalled();
    expect(setData).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
  });
});

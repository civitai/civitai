import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// Sellers could see only their open incoming requests, so a request they declined was gone.

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: () => ({ data: { canSell: true }, isLoading: false }),
    },
    'creatorService.getMine': {
      useQuery: () => ({ data: { items: [], hiddenOffDomain: 0 }, isLoading: false }),
    },
  }),
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceDealsList', () => ({
  ServiceDealsList: ({ role, status }: { role: string; status: string }) => (
    <p>{`deals:${role}:${status}`}</p>
  ),
}));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingFormModal', () => ({
  ServiceOfferingFormModal: () => null,
}));
vi.mock('~/providers/AppProvider', () => ({
  useServerDomains: () => ({ green: 'green.test', blue: 'blue.test', red: 'civitai.red' }),
}));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: '/user/seller/shop/manage' }) }));

import { ManageServicesPanel } from '~/components/CreatorShop/Services/ManageServicesPanel';

describe('incoming requests on the seller panel', () => {
  test('lists open requests first, and closed ones from the Closed tab', async () => {
    renderWithProviders(<ManageServicesPanel />);
    await expect.element(page.getByText('deals:seller:open')).toBeInTheDocument();

    await page.getByRole('tab', { name: 'Closed' }).click();
    await expect.element(page.getByText('deals:seller:closed')).toBeInTheDocument();
    await expect.element(page.getByText('deals:seller:open')).not.toBeInTheDocument();
  });
});

// Mantine's stylesheet, so the row lays out as it does in the app (the harness loads none).
import '@mantine/core/styles.css';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as DomainColorModule from '~/hooks/useDomainColor';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// Sellers could see only their open incoming requests, so a request they declined was gone.

const { mine } = vi.hoisted(() => ({ mine: { items: [] as unknown[], hiddenOffDomain: 0 } }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: () => ({ data: { canSell: true }, isLoading: false }),
    },
    'creatorService.getMine': {
      useQuery: () => ({ data: mine, isLoading: false }),
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
// The domain comes from the feature-flag context, which this harness does not mount.
vi.mock('~/hooks/useDomainColor', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainColorModule>()),
  useDomainColor: () => 'green',
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

describe('a service row on a phone', () => {
  afterEach(async () => {
    mine.items = [];
    await page.viewport(1280, 720);
  });

  test('keeps the actions button visible and tappable beside a long title and every badge', async () => {
    mine.items = [
      {
        id: 1,
        title: 'Fully custom character sheet with three poses, colour palette and prompt notes',
        status: 'Draft',
        maxNsfwLevel: 8,
        review: 'reviewing',
        deliveryDays: 5,
        revisionsIncluded: 2,
        maxOpenDeals: 3,
        price: 125000,
        termsAffirmed: false,
      },
    ];
    await page.viewport(390, 844);
    renderWithProviders(<ManageServicesPanel />);
    await expect.element(page.getByRole('button', { name: 'Service actions' })).toBeVisible();

    const button = document.querySelector<HTMLElement>('[aria-label="Service actions"]')!;
    const box = button.getBoundingClientRect();
    const icon = button.querySelector('svg')!.getBoundingClientRect();
    expect(icon.width).toBeGreaterThanOrEqual(16);
    expect(box.right).toBeLessThanOrEqual(390);
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(button.contains(hit)).toBe(true);
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as AppProviderModule from '~/providers/AppProvider';
import type * as DialogProviderModule from '~/components/Dialog/DialogProvider';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// A seller had no way to see their service as a buyer would, and Manage opened the whole list.

const state = vi.hoisted(() => ({
  trigger: vi.fn(),
  canSell: true,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProviderModule>()),
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreModule>()),
  dialogStore: { trigger: state.trigger },
}));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingMenu', () => ({
  ServiceOfferingMenu: () => <p>owner-menu</p>,
}));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingFormModal', () => ({
  ServiceOfferingFormModal: () => null,
}));
vi.mock('~/components/CreatorShop/Services/deals/ServiceDealsList', () => ({
  ServiceDealsList: () => null,
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProviderModule>()),
  useServerDomains: () => ({ green: 'green.test', blue: 'blue.test', red: 'civitai.red' }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));

const offering = {
  id: 3,
  title: 'Portrait commission',
  description: 'One painted portrait of your character.',
  price: 500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  maxNsfwLevel: 1,
  status: 'Active',
  licensePreset: null,
  licenseCustomText: null,
  licenseAllowResale: false,
  requestForm: null,
  requestFormVersion: 0,
  fromPrice: null,
};

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: () => ({
        data: { canSell: state.canSell, score: { current: 0, min: 5000 }, standingIssue: null },
        isLoading: false,
      }),
    },
    'creatorService.getMine': {
      useQuery: () => ({ data: { items: [offering], hiddenOffDomain: 0 }, isLoading: false }),
    },
  }),
}));

import router from 'next/router';
import { ServiceOfferingFormModal } from '~/components/CreatorShop/Services/ServiceOfferingFormModal';
import { ManageServicesPanel } from '~/components/CreatorShop/Services/ManageServicesPanel';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { BUYER_DISCLOSURE_INTRO } from '~/shared/constants/creator-service-terms.constants';

// component-setup's router stub is one shared object: set its route per test.
const managePage = (query: Record<string, string>) =>
  Object.assign(router, { pathname: '/user/[username]/shop/manage', query });

beforeEach(() => {
  state.trigger.mockClear();
  vi.mocked(router.replace).mockClear();
  state.canSell = true;
});

describe("the owner's service card", () => {
  test('Manage goes straight to editing that service', async () => {
    renderWithProviders(
      <ServiceOfferingCard offering={offering} sellerId={1} sellerUsername="mei" />
    );
    await expect
      .element(page.getByRole('link', { name: 'Manage' }))
      .toHaveAttribute('href', '/user/mei/shop/manage?tab=services&edit=3');
  });

  test("Preview as buyer shows the buyer's card and description, with nothing that acts", async () => {
    renderWithProviders(
      <ServiceOfferingCard offering={offering} sellerId={1} sellerUsername="mei" />
    );
    await page.getByRole('button', { name: 'Preview as buyer' }).click();
    expect(state.trigger).toHaveBeenCalledTimes(1);
    const { component: Preview, props } = state.trigger.mock.calls[0][0];
    renderWithProviders(<Preview {...props} />);

    const dialog = page.getByRole('dialog', { name: 'Preview as a buyer' });
    await expect
      .element(dialog.getByText('One painted portrait of your character.'))
      .toBeInTheDocument();
    await expect.element(dialog.getByText(BUYER_DISCLOSURE_INTRO)).toBeInTheDocument();
    await expect.element(dialog.getByRole('button', { name: 'Request' })).toBeDisabled();
    await expect.element(dialog.getByRole('link', { name: 'Manage' })).not.toBeInTheDocument();
    await expect.element(dialog.getByText('owner-menu')).not.toBeInTheDocument();
  });
});

describe('the manage page opened from a card', () => {
  test('opens the form for that offering and drops ?edit', async () => {
    managePage({ username: 'mei', tab: 'services', edit: '3' });
    renderWithProviders(<ManageServicesPanel />);
    await vi.waitFor(() =>
      expect(state.trigger).toHaveBeenCalledWith({
        component: ServiceOfferingFormModal,
        props: { offering },
      })
    );
    // The stub router never drops ?edit, so a re-render (switching tabs) must not open a second form.
    await page.getByRole('tab', { name: 'Closed' }).click();
    expect(state.trigger).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      { pathname: '/user/[username]/shop/manage', query: { username: 'mei', tab: 'services' } },
      undefined,
      { shallow: true }
    );
  });

  test('opens no form for a seller who cannot sell, and still drops ?edit', async () => {
    managePage({ username: 'mei', tab: 'services', edit: '3' });
    state.canSell = false;
    renderWithProviders(<ManageServicesPanel />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(state.trigger).not.toHaveBeenCalled();
  });

  test("opens no form for an id that isn't one of the seller's, and still drops ?edit", async () => {
    managePage({ username: 'mei', tab: 'services', edit: '999' });
    renderWithProviders(<ManageServicesPanel />);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(state.trigger).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const state = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  eligibility: null as unknown,
  trigger: vi.fn(),
  requireLogin: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'creatorService.getSellEligibility': {
      useQuery: () => ({ data: state.eligibility, isLoading: false }),
    },
  }),
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreModule>()),
  dialogStore: { trigger: state.trigger },
}));
vi.mock('~/components/CreatorShop/Services/ServiceOfferingFormModal', () => ({
  ServiceOfferingFormModal: () => <p>new-service-form</p>,
}));
vi.mock('~/components/Login/requireLogin', () => ({ requireLogin: state.requireLogin }));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: '/services' }) }));

import { ServicesKickoffHero } from '~/components/CreatorShop/Services/feed/ServicesKickoffHero';

const listButton = () => page.getByRole('button', { name: 'List your service' });

describe('List your service on the services hero', () => {
  beforeEach(() => {
    state.user = { id: 1 };
    state.trigger.mockClear();
    state.requireLogin.mockClear();
  });

  test('opens the new-service form for a seller who can sell', async () => {
    state.eligibility = { canSell: true, score: { current: 9000, min: 5000 }, standingIssue: null };
    renderWithProviders(<ServicesKickoffHero />);

    await listButton().click();
    expect(state.trigger).toHaveBeenCalledTimes(1);
    const { component: Opened } = state.trigger.mock.calls[0][0];
    renderWithProviders(<Opened />);
    await expect.element(page.getByText('new-service-form')).toBeInTheDocument();
  });

  test('shows why a viewer below the Creator Score bar cannot sell, and opens no form', async () => {
    state.eligibility = {
      canSell: false,
      score: { current: 1200, min: 5000 },
      standingIssue: null,
    };
    renderWithProviders(<ServicesKickoffHero />);

    await listButton().click();
    await expect
      .element(page.getByText('Services unlock at Beacon (5,000 Creator Score)'))
      .toBeVisible();
    await expect.element(page.getByText(/You're at\s+1,200/)).toBeVisible();
    expect(state.trigger).not.toHaveBeenCalled();
  });

  test('asks a signed-out viewer to sign in', async () => {
    state.user = null;
    state.eligibility = undefined;
    renderWithProviders(<ServicesKickoffHero />);

    await listButton().click();
    expect(state.requireLogin).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'list-service' })
    );
    expect(state.trigger).not.toHaveBeenCalled();
  });
});

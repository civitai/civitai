import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as Notifications from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const { listState, mutate } = vi.hoisted(() => ({
  listState: { items: [] as unknown[], isLoading: false },
  mutate: vi.fn(),
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'appListings.listMyCatalogSubListings': {
          useQuery: () => ({ data: { items: listState.items }, isLoading: listState.isLoading }),
        },
        'appListings.withdrawMyCatalogSubListing': {
          useMutation: () => ({ mutate, isPending: false, variables: undefined }),
        },
      },
      {
        useUtils: () => ({
          appListings: { listMyCatalogSubListings: { setData: vi.fn(), invalidate: vi.fn() } },
        }),
      }
    ),
  };
});

import { ModalsProvider } from '@mantine/modals';
import { CatalogItemsCard } from '~/components/Account/CatalogItemsCard';

// The withdraw asks for confirmation through `openConfirmModal`, which needs a ModalsProvider.
const renderCard = () =>
  renderWithProviders(
    <ModalsProvider>
      <CatalogItemsCard />
    </ModalsProvider>
  );

const parent = {
  id: 'apl_GAMES',
  slug: 'games-site',
  name: 'Games Site',
  clientId: 'client-games',
};
const item = (id: string, title: string, status: string, href: string | null = null) => ({
  id,
  externalId: id.toLowerCase(),
  title,
  status,
  pendingEdit: false,
  statusReason: status === 'hidden' ? 'Not allowed' : null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  href,
  parent,
});

beforeEach(() => {
  vi.clearAllMocks();
  listState.isLoading = false;
  listState.items = [
    item('asl_LIVE', 'Live Game', 'approved', 'https://games.example.com/?game=live'),
    item('asl_REVIEW', 'Review Game', 'pending'),
    item('asl_HIDDEN', 'Hidden Game', 'hidden'),
    item('asl_GONE', 'Gone Game', 'withdrawn'),
  ];
});

describe('CatalogItemsCard', () => {
  test('lists each item with its status, parent listing and link', async () => {
    renderCard();
    await expect.element(page.getByText('Live', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('In review')).toBeInTheDocument();
    await expect.element(page.getByText('Hidden by a moderator')).toBeInTheDocument();
    await expect.element(page.getByText('Withdrawn', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: 'Live Game' }))
      .toHaveAttribute('href', 'https://games.example.com/?game=live');
    await expect
      .element(page.getByRole('link', { name: 'Games Site' }).first())
      .toHaveAttribute('href', '/apps/store-preview/games-site');
  });

  test('offers withdraw only on items in the store or in review', async () => {
    renderCard();
    await expect.element(page.getByLabelText('Withdraw Live Game')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Withdraw Review Game')).toBeInTheDocument();
    expect(page.getByLabelText('Withdraw Hidden Game').elements()).toHaveLength(0);
    expect(page.getByLabelText('Withdraw Gone Game').elements()).toHaveLength(0);
  });

  test('withdraws the chosen item after confirmation', async () => {
    renderCard();
    await userEvent.click(page.getByLabelText('Withdraw Review Game'));
    await userEvent.click(page.getByRole('button', { name: 'Withdraw', exact: true }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ id: 'asl_REVIEW' });
  });

  test('renders nothing when the user has no catalog items', async () => {
    listState.items = [];
    await renderCard();
    expect(page.getByText('Store items listed under your name').elements()).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="catalog-item-row"]')).toHaveLength(0);
  });

  test('renders its title when there are items (control for the empty case)', async () => {
    await renderCard();
    await expect.element(page.getByText('Store items listed under your name')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="catalog-item-row"]')).toHaveLength(4);
  });
});

import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../test/component-setup';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { requireLogin } from '~/components/Login/requireLogin';
import { CollectionsHome } from '~/components/Collections/CollectionsHome';

/**
 * The user menu's Collections item links to `/collections`. That page used to push a signed-in
 * owner straight into their first collection; it must stay put and, on a phone, offer the list.
 */
const state = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  collections: [] as { id: number; isOwner: boolean }[],
  isMobile: true,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'collection.getAllUser': {
      useQuery: () => ({ data: state.collections, isLoading: false }),
    },
  }),
}));
vi.mock('~/components/ContainerProvider/useContainerSmallerThan', () => ({
  useContainerSmallerThan: () => state.isMobile,
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: vi.fn() } }));
vi.mock('~/components/Login/requireLogin', () => ({ requireLogin: vi.fn() }));
vi.mock('~/components/Collections/CollectionEditModal', () => ({
  default: function CollectionEditModal() {
    return <div>collection-editor</div>;
  },
}));
vi.mock('~/components/Collections/CollectionCollaborators/CollectionInvitesButton', () => ({
  CollectionInvitesButton: () => null,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Collections/MyCollections', () => ({
  MyCollections: ({
    children,
    onSelect,
  }: {
    onSelect?: () => void;
    children: (parts: Record<string, React.ReactNode>) => React.ReactNode;
  }) =>
    children({
      FilterBox: null,
      Filters: null,
      ListMenu: null,
      InviteList: null,
      // Only the drawer passes `onSelect`; the desktop sidebar renders this component too.
      Collections: <div>{onSelect ? 'drawer-list' : 'sidebar-list'}</div>,
    }),
}));

const listVisible = () => document.body.textContent?.includes('drawer-list') ?? false;

describe('/collections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: 1 };
    state.collections = [{ id: 42, isOwner: true }];
    state.isMobile = true;
  });

  test('does not redirect an owner into their first collection', async () => {
    renderWithProviders(<CollectionsHome />);
    await expect.element(page.getByText('Pick a collection')).toBeVisible();
    expect(useRouter().push).not.toHaveBeenCalled();
  });

  test('phone: opens the collections drawer once; closing it keeps it closed', async () => {
    const view = await renderWithProviders(<CollectionsHome />);
    await expect.element(page.getByText('drawer-list')).toBeVisible();

    await userEvent.keyboard('{Escape}');
    await expect.poll(listVisible).toBe(false);

    // The owned collection disappears and comes back (a delete then an undo, a refetch): the
    // flag flips false -> true again, which must not re-open it.
    state.collections = [];
    await view.rerender(<CollectionsHome />);
    state.collections = [{ id: 42, isOwner: true }];
    await view.rerender(<CollectionsHome />);
    await new Promise((r) => setTimeout(r, 300));
    expect(listVisible()).toBe(false);
  });

  test('phone: no owned collection leaves the drawer closed', async () => {
    state.collections = [{ id: 9, isOwner: false }];
    renderWithProviders(<CollectionsHome />);
    await expect.element(page.getByText('Pick a collection')).toBeVisible();
    await new Promise((r) => setTimeout(r, 300));
    expect(listVisible()).toBe(false);
  });

  test('phone: signed out leaves the drawer closed', async () => {
    state.user = null;
    renderWithProviders(<CollectionsHome />);
    await expect.element(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await new Promise((r) => setTimeout(r, 300));
    expect(listVisible()).toBe(false);
  });

  test('desktop: no drawer; the sidebar list stays beside the landing', async () => {
    state.isMobile = false;
    renderWithProviders(<CollectionsHome />);
    await expect.element(page.getByText('Pick a collection')).toBeVisible();
    await expect.element(page.getByText('sidebar-list')).toBeVisible();
    await new Promise((r) => setTimeout(r, 300));
    expect(listVisible()).toBe(false);
  });

  describe('landing states', () => {
    test('signed in with collections: points at the Collections button on a phone, the list on desktop', async () => {
      const view = await renderWithProviders(<CollectionsHome />);
      await expect.element(page.getByText('Tap the Collections button above')).toBeVisible();

      state.isMobile = false;
      await view.rerender(<CollectionsHome />);
      await expect.element(page.getByText('Choose one from the list on the left')).toBeVisible();
    });

    test('Create collection opens the collection editor', async () => {
      // Desktop: on a phone the auto-opened drawer would cover the button.
      state.isMobile = false;
      renderWithProviders(<CollectionsHome />);
      await userEvent.click(page.getByRole('button', { name: 'Create collection' }));
      expect(dialogStore.trigger).toHaveBeenCalledTimes(1);

      const { component: Editor } = vi.mocked(dialogStore.trigger).mock.calls[0][0] as {
        component: React.ComponentType;
      };
      renderWithProviders(<Editor />);
      await expect.element(page.getByText('collection-editor')).toBeVisible();
    });

    test('signed in with no collections: explains collections and offers Create', async () => {
      state.collections = [];
      renderWithProviders(<CollectionsHome />);
      await expect.element(page.getByText('No collections yet')).toBeVisible();
      await expect.element(page.getByText('Collections let you save')).toBeVisible();
      await expect.element(page.getByRole('button', { name: 'Create collection' })).toBeVisible();
      expect(page.getByRole('button', { name: 'Sign in' }).elements()).toHaveLength(0);
    });

    test('signed out: explains collections and the button goes through login, not Create', async () => {
      state.user = null;
      renderWithProviders(<CollectionsHome />);
      await expect.element(page.getByText('Collections let you save')).toBeVisible();
      expect(page.getByRole('button', { name: 'Create collection' }).elements()).toHaveLength(0);

      await userEvent.click(page.getByRole('button', { name: 'Sign in' }));
      expect(requireLogin).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'perform-action', returnUrl: '/collections' })
      );
      expect(dialogStore.trigger).not.toHaveBeenCalled();
    });
  });
});

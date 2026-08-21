/**
 * A rejection is terminal, and the creator's row menu has to say so: editing,
 * listing and archiving a rejected item are all refused server-side, and
 * archiving used to be the two-click way around it (restore re-entered the queue
 * with the verdict cleared).
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { theme } from '~/providers/ThemeProvider';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import type * as TrpcModule from '~/utils/trpc';

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    creatorShop: {
      getItemResellers: { useQuery: () => ({ data: [], isLoading: false }) },
    },
  },
}));

// The real hook throws without CivitaiSessionProvider; a non-moderator is the
// case that matters here (a moderator also sees Delete).
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { ManageItemsTable } = await import('~/components/CreatorShop/Manage/ManageItemsTable');

const noopMutation = { mutate: vi.fn(), isPending: false } as never;

const item = (status: CosmeticShopItemStatus, history?: unknown[]) =>
  ({
    id: 1,
    title: 'Pastel Shooting Star',
    cosmetic: { id: 9, name: 'Pastel Shooting Star', type: 'Badge', data: { url: 'art' } },
    meta: { history },
    resellerCount: 0,
    status,
    purchases: 0,
    unitAmount: 500,
    createdAt: new Date(),
    listed: false,
    rejectionReason: status === CosmeticShopItemStatus.Rejected ? 'not a fit' : null,
  } as unknown as CreatorShopManageItem);

async function openRowMenu(status: CosmeticShopItemStatus, history?: unknown[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { container } = await render(
    <ManageItemsTable
      items={[item(status, history)]}
      archiveItem={noopMutation}
      setItemListed={noopMutation}
      unarchiveItem={noopMutation}
      deleteItem={noopMutation}
    />,
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <MantineProvider theme={theme}>{children}</MantineProvider>
        </QueryClientProvider>
      ),
    }
  );

  const trigger = container.querySelector('.mantine-ActionIcon-root') as HTMLElement;
  expect(trigger, 'no row actions trigger rendered').not.toBeNull();
  await page.elementLocator(trigger).click();

  // The dropdown is portalled out of the table, so it is found on the document.
  const dropdown = await vi.waitUntil(() => document.querySelector('.mantine-Menu-dropdown'));
  return dropdown as HTMLElement;
}

describe('manage row actions', () => {
  test('a rejected item offers nothing to change — only why', async () => {
    const dropdown = await openRowMenu(CosmeticShopItemStatus.Rejected);
    expect(dropdown.textContent).toContain('this item is final');
    expect(dropdown.textContent).not.toContain('Edit');
    expect(dropdown.textContent).not.toContain('Archive');
    expect(dropdown.textContent).not.toContain('Restore');
  });

  // Archiving a rejected item is refused now, but rows archived while it was
  // allowed still exist — and restoring one is refused server-side, so the menu
  // must not offer it.
  test('an item archived after a rejection offers no Restore', async () => {
    const dropdown = await openRowMenu(CosmeticShopItemStatus.Archived, [
      { at: '2026-08-02T00:00:00.000Z', userId: 99, kind: 'reviewed', action: 'reject' },
    ]);
    expect(dropdown.textContent).toContain('this item is final');
    expect(dropdown.textContent).not.toContain('Restore');
  });

  // Control: an item archived after anything else still restores.
  test('an item archived after a change request still offers Restore', async () => {
    const dropdown = await openRowMenu(CosmeticShopItemStatus.Archived, [
      { at: '2026-08-02T00:00:00.000Z', userId: 99, kind: 'reviewed', action: 'request-changes' },
    ]);
    expect(dropdown.textContent).toContain('Restore');
    expect(dropdown.textContent).not.toContain('this item is final');
  });

  // Control: the same queries DO find those items on an item that was only sent
  // back for changes, so the assertions above are capable of failing.
  test('an item sent back for changes still offers Edit and Archive', async () => {
    const dropdown = await openRowMenu(CosmeticShopItemStatus.RequestedChanges);
    expect(dropdown.textContent).toContain('Edit & resubmit');
    expect(dropdown.textContent).toContain('Archive');
    expect(dropdown.textContent).not.toContain('this item is final');
  });
});

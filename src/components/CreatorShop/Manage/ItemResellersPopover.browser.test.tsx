import { MantineProvider, Popover } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import type * as UserAvatarModule from '~/components/UserAvatar/UserAvatar';
import { theme } from '~/providers/ThemeProvider';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import type * as TrpcModule from '~/utils/trpc';

const RESELLERS = [
  { user: { id: 1, username: 'ada', image: null }, sellerShare: 30, listedAt: new Date() },
  { user: { id: 2, username: 'bo', image: null }, sellerShare: 40, listedAt: new Date() },
  { user: { id: 3, username: 'cy', image: null }, sellerShare: 50, listedAt: new Date() },
];

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    creatorShop: {
      getItemResellers: { useQuery: () => ({ data: RESELLERS, isLoading: false }) },
    },
  },
}));

vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarModule>()),
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

// The real hook throws without CivitaiSessionProvider, and the row's actions menu
// is the only thing in the table that reads it.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { ManageItemsTable } = await import('~/components/CreatorShop/Manage/ManageItemsTable');

const SCROLL_CONTAINER = '.mantine-ScrollArea-root';
const DROPDOWN = '.mantine-Popover-dropdown';

const ITEM = {
  id: 1,
  title: 'Pastel Shooting Star',
  cosmetic: null,
  meta: {},
  resellerCount: RESELLERS.length,
  status: CosmeticShopItemStatus.Published,
  purchases: 0,
  unitAmount: 500,
  createdAt: new Date(),
  listed: true,
  rejectionReason: null,
} as unknown as CreatorShopManageItem;

const noopMutation = { mutate: vi.fn(), isPending: false } as never;

function renderTable(extra?: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <>
      <ManageItemsTable
        items={[ITEM]}
        archiveItem={noopMutation}
        setItemListed={noopMutation}
        unarchiveItem={noopMutation}
        deleteItem={noopMutation}
      />
      {extra}
    </>,
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <MantineProvider theme={theme}>{children}</MantineProvider>
        </QueryClientProvider>
      ),
    }
  );
}

describe('ItemResellersPopover — the dropdown escapes the manage table', () => {
  test('opens its dropdown outside the table scroll container', async () => {
    renderTable();

    await page.getByText('3 creators resell this').click();
    await expect.element(page.getByText('ada')).toBeInTheDocument();

    const dropdown = document.querySelector(DROPDOWN);
    const scrollContainer = document.querySelector(SCROLL_CONTAINER);
    expect(dropdown).not.toBeNull();
    // Fails loudly if ManageItemsTable ever stops using Table.ScrollContainer —
    // this guard is only meaningful while that clipping ancestor exists.
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer!.contains(dropdown!)).toBe(false);
    // The table has a SECOND clipping ancestor — the Paper wrapping it also sets
    // overflow-hidden — so escaping the scroll container alone is not enough.
    const paper = document.querySelector('.mantine-Paper-root');
    expect(paper).not.toBeNull();
    expect(paper!.contains(dropdown!)).toBe(false);
  });

  // Positive control for the harness: an unportalled popover rendered in the same
  // table DOES land inside the clipping ancestor, so the assertion above is
  // capable of failing.
  test('an unportalled popover in the same table lands inside it', async () => {
    renderTable();

    await page.getByText('3 creators resell this').click();
    await expect.element(page.getByText('ada')).toBeInTheDocument();

    const scrollContainer = document.querySelector(SCROLL_CONTAINER)!;
    const cell = scrollContainer.querySelector('td')!;
    const control = document.createElement('div');
    cell.appendChild(control);

    render(
      <MantineProvider theme={theme}>
        <Popover opened position="bottom-start" withinPortal={false}>
          <Popover.Target>
            <button type="button">control</button>
          </Popover.Target>
          <Popover.Dropdown>control body</Popover.Dropdown>
        </Popover>
      </MantineProvider>,
      { container: control }
    );

    await expect.element(page.getByText('control body')).toBeInTheDocument();
    const controlDropdown = control.querySelector(DROPDOWN);
    expect(controlDropdown).not.toBeNull();
    expect(scrollContainer.contains(controlDropdown!)).toBe(true);
  });

  // The fix only matters because the app theme opts every Popover out of a portal.
  // Pinned separately so removing that default reports itself here rather than as
  // an unexplained failure in the tests above.
  test('the app theme still defaults popovers out of a portal', () => {
    expect(theme.components?.Popover?.defaultProps?.withinPortal).toBe(false);
  });
});

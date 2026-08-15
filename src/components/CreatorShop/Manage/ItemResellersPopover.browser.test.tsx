import { Paper, Popover, Table, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { render } from 'vitest-browser-react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { theme } from '~/providers/ThemeProvider';

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

vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

const { ItemResellersPopover } = await import(
  '~/components/CreatorShop/Manage/ItemResellersPopover'
);

const SCROLL_CONTAINER = '.mantine-ScrollArea-root';

// The wrappers ManageItemsTable puts around every cell: a Paper that clips its
// overflow, and Table.ScrollContainer, whose ScrollArea root is
// `position: relative; overflow: hidden`. Anything absolutely positioned inside
// that subtree is clipped by it, which is what hid the reseller list.
function Harness({ children }: { children: React.ReactNode }) {
  return (
    <Paper withBorder radius="md" className="overflow-hidden" style={{ width: 400 }}>
      <Table.ScrollContainer minWidth={860}>
        <Table layout="fixed">
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>{children}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}

function renderInTable(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {/* The app theme, not a bare provider — it is the theme that defaults
            every Popover to withinPortal={false}, so a bare MantineProvider
            would portal the dropdown on its own and pass either way. */}
        <MantineProvider theme={theme}>
          <Harness>{children}</Harness>
        </MantineProvider>
      </QueryClientProvider>
    ),
  });
}

describe('ItemResellersPopover — the dropdown escapes the table scroll container', () => {
  test('renders its dropdown outside the clipping ancestor', async () => {
    renderInTable(<ItemResellersPopover shopItemId={1} count={3} />);

    await page.getByText('3 creators resell this').click();
    await expect.element(page.getByText('ada')).toBeInTheDocument();

    const dropdown = document.querySelector('.mantine-Popover-dropdown');
    const scrollContainer = document.querySelector(SCROLL_CONTAINER);
    expect(dropdown).not.toBeNull();
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer!.contains(dropdown!)).toBe(false);
  });

  // Positive control: the same Popover WITHOUT the prop, under the same theme and
  // the same wrappers, does land inside the clipping ancestor. Without this, a
  // harness that silently lost the app theme would pass the test above for the
  // wrong reason.
  test('a popover left on the theme default lands inside it', async () => {
    renderInTable(
      <Popover opened position="bottom-start">
        <Popover.Target>
          <button type="button">control</button>
        </Popover.Target>
        <Popover.Dropdown>control body</Popover.Dropdown>
      </Popover>
    );

    await expect.element(page.getByText('control body')).toBeInTheDocument();

    const dropdown = document.querySelector('.mantine-Popover-dropdown');
    const scrollContainer = document.querySelector(SCROLL_CONTAINER);
    expect(dropdown).not.toBeNull();
    expect(scrollContainer!.contains(dropdown!)).toBe(true);
  });
});

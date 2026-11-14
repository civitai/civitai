import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * Saving the editor sets the viewer's whole list of home blocks, so a list that failed to load
 * must not be saved: it would save as empty and remove every block they had.
 */

const { mutate, ownedList, renders } = vi.hoisted(() => ({
  mutate: vi.fn(),
  ownedList: { current: {} as Record<string, unknown> },
  // Renders of the modal: a state loop fails the test here instead of hanging the browser.
  renders: { count: 0 },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'homeBlock.getHomeBlocks': {
      useQuery: () => {
        if (++renders.count > 100) throw new Error(`render loop: ${renders.count} renders`);
        return ownedList.current;
      },
    },
    'homeBlock.getSystemHomeBlocks': { useQuery: () => ({ data: [], isLoading: false }) },
    'homeBlock.setHomeBlockOrder': { useMutation: () => ({ mutate, isPending: false }) },
  }),
}));

import { ManageHomeBlocks } from '~/components/HomeBlocks/ManageHomeBlocksModal';

const OWN_BLOCK = {
  id: 11,
  userId: 5,
  type: 'Feed',
  index: 0,
  metadata: { title: 'My feed' },
};

beforeEach(() => {
  vi.clearAllMocks();
  renders.count = 0;
});

describe('ManageHomeBlocks Save', () => {
  test.each([
    ['failed to load', { data: undefined, isLoading: false, isError: true }],
    // React Query parks a first fetch made offline: no data, neither loading nor errored.
    ['is paused offline', { data: undefined, isLoading: false, isError: false }],
  ])('is off when the list of your blocks %s', async (_label, query) => {
    ownedList.current = query;
    renderWithProviders(<ManageHomeBlocks onClose={() => undefined} />);

    await expect.element(page.getByText('Your home blocks could not be loaded')).toBeVisible();
    const save = page.getByRole('button', { name: 'Save' });
    await expect.element(save).toBeDisabled();
    await userEvent.click(save, { force: true });
    expect(mutate).not.toHaveBeenCalled();
    expect(renders.count).toBeLessThan(20);
  });

  test('saves the loaded list (control)', async () => {
    ownedList.current = { data: [OWN_BLOCK], isLoading: false, isError: false };
    renderWithProviders(<ManageHomeBlocks onClose={() => undefined} />);

    const save = page.getByRole('button', { name: 'Save' });
    await expect.element(save).toBeEnabled();
    await userEvent.click(save);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toEqual({
      homeBlocks: [{ id: OWN_BLOCK.id, index: 0, userId: OWN_BLOCK.userId }],
    });
  });
});

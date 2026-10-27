import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';

/**
 * The moderator queue's actions are the ONLY way builder access is granted or taken away, so what
 * each button sends is the contract: Approve and Decline on a pending row, Revoke (a decline) on an
 * approved one, and nothing on a declined one.
 */

const mocks = vi.hoisted(() => ({
  items: [] as unknown[],
  decided: [] as unknown[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appAccessRequest.list': {
      useInfiniteQuery: () => ({
        data: { pages: [{ items: mocks.items, nextCursor: null }] },
        isLoading: false,
        hasNextPage: false,
      }),
    },
    'appAccessRequest.decide': {
      useMutation: () => ({
        mutate: (input: unknown) => mocks.decided.push(input),
        isPending: false,
        variables: undefined,
      }),
    },
  }),
}));

// The avatar reads feature flags and cosmetics; it is not what this file measures.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string | null } }) => <span>{user.username}</span>,
}));

const { AppAccessRequestsQueue } = await import('./AppAccessRequestsQueue');

const row = (id: number, status: 'pending' | 'approved' | 'declined') => ({
  id,
  userId: 9000 + id,
  username: `builder_${id}`,
  whatToBuild: `Idea number ${id}: a palette board that turns liked images into prompts.`,
  status,
  createdAt: new Date('2026-10-20T09:00:00Z'),
  reviewedAt: status === 'pending' ? null : new Date('2026-10-21T09:00:00Z'),
  reviewedById: status === 'pending' ? null : 3,
  reviewedByUsername: status === 'pending' ? null : 'queue_reviewer',
});

const inRow = (id: number) => page.getByTestId(`app-access-request-${id}`);

beforeEach(() => {
  mocks.items = [row(11, 'pending'), row(12, 'approved'), row(13, 'declined')];
  mocks.decided = [];
});

describe('AppAccessRequestsQueue — the actions that grant and revoke', () => {
  test('a pending row offers Approve and Decline, each sending its decision for THAT row', async () => {
    renderWithProviders(<AppAccessRequestsQueue />);
    await inRow(11).getByRole('button', { name: 'Approve' }).click();
    await inRow(11).getByRole('button', { name: 'Decline' }).click();
    expect(mocks.decided).toEqual([
      { id: 11, decision: 'approved' },
      { id: 11, decision: 'declined' },
    ]);
  });

  test('🔴 an approved row offers Revoke, which sends a DECLINE for that row', async () => {
    renderWithProviders(<AppAccessRequestsQueue />);
    await expect.element(inRow(12)).toBeInTheDocument();
    expect(inRow(12).getByRole('button', { name: 'Approve' }).elements()).toHaveLength(0);
    await page.getByTestId('app-access-request-revoke-12').click();
    expect(mocks.decided).toEqual([{ id: 12, decision: 'declined' }]);
  });

  test('a declined row offers no action', async () => {
    renderWithProviders(<AppAccessRequestsQueue />);
    await expect.element(inRow(13)).toBeInTheDocument();
    expect(inRow(13).getByRole('button').elements()).toHaveLength(0);
  });

  test('the banner says approving grants access', async () => {
    renderWithProviders(<AppAccessRequestsQueue />);
    await expect.element(page.getByText('Approving grants access')).toBeInTheDocument();
  });
});

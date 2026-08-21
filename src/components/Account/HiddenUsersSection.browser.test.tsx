import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as HiddenPreferences from '~/hooks/hidden-preferences';
import type * as TrpcModule from '~/utils/trpc';

/**
 * 868kurj0y. This search box is a second `kind: 'user'` writer and NOT a
 * `HideUserButton` call site, so the block gate on that component does not reach it.
 *
 * `toHideableOptions` is unit-tested beside it; what this covers is the argument
 * that connects it to `blockedUsers` — passing `[]` there leaves the helper green
 * and the box still offering blocked users.
 */

const mocks = vi.hoisted(() => ({
  blockedUsers: [] as Array<{ id: number }>,
  users: [] as Array<{ id: number; username: string | null }>,
}));

vi.mock('~/hooks/hidden-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferences>()),
  useHiddenPreferencesData: () => ({ hiddenUsers: [], blockedUsers: mocks.blockedUsers }),
  useToggleHiddenPreferences: () => ({ mutateAsync: vi.fn().mockResolvedValue({}) }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    user: {
      getAll: { useQuery: () => ({ data: mocks.users, isLoading: false, isFetching: false }) },
    },
  },
}));

vi.mock('~/components/MasonryGrid/BasicMasonryGrid', () => ({
  BasicMasonryGrid: () => <div data-testid="grid" />,
}));

const { HiddenUsersSection } = await import('./HiddenUsersSection');

beforeEach(() => {
  mocks.blockedUsers = [];
  // A shared prefix so one query returns both — Mantine filters the dropdown by the
  // input text, so unrelated names would hide the anchor rather than the subject.
  mocks.users = [
    { id: 1, username: 'tester_alice' },
    { id: 2, username: 'tester_bob' },
  ];
});

describe('HiddenUsersSection — blocked users are not offered as hideable', () => {
  const openOptions = async () => {
    const input = page.getByPlaceholder('Search users to hide');
    await input.click();
    await input.fill('tester');
    return input;
  };

  test('a blocked user is absent from the options', async () => {
    mocks.blockedUsers = [{ id: 2 }];

    renderWithProviders(<HiddenUsersSection />);
    await openOptions();

    // `tester_alice` proves the dropdown actually opened, so `bob`'s absence is a real
    // exclusion rather than an unrendered list.
    await expect.element(page.getByRole('option', { name: 'tester_alice' })).toBeInTheDocument();
    expect(page.getByRole('option', { name: 'tester_bob' }).elements()).toHaveLength(0);
  });

  // Negative control: passing `[]` for blockedUsers passes the test above only if
  // this one is absent.
  test('an unblocked user is offered', async () => {
    renderWithProviders(<HiddenUsersSection />);
    await openOptions();

    await expect.element(page.getByRole('option', { name: 'tester_bob' })).toBeInTheDocument();
  });
});

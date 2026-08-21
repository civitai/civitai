import { Menu } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 868kurj0y — `Block > Hide > Follow`, so a hide over an existing block is refused
 * server-side (#4230). The control must not be offered on a user the viewer has
 * already blocked.
 *
 * Both states here are stable: neither the rendered control nor its absence is
 * torn down on a timer, so there is no self-deleting state to race. The absence
 * assertions still await a sibling anchor first, so "not found" cannot pass merely
 * because nothing has mounted yet.
 */

const mocks = vi.hoisted(() => ({
  hiddenUsers: [] as Array<{ id: number }>,
  blockedUsers: [] as Array<{ id: number }>,
  currentUser: { id: 1 } as { id: number } | null,
  toggleResult: {} as { hidden?: boolean },
  showSuccess: vi.fn(),
}));

vi.mock('~/hooks/hidden-preferences', () => ({
  useHiddenPreferencesData: () => ({
    hiddenUsers: mocks.hiddenUsers,
    blockedUsers: mocks.blockedUsers,
  }),
  useToggleHiddenPreferences: () => ({
    mutateAsync: () => Promise.resolve(mocks.toggleResult),
    isPending: false,
  }),
}));

vi.mock('~/utils/notifications', () => ({ showSuccessNotification: mocks.showSuccess }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { HideUserButton } = await import('./HideUserButton');

const TARGET = 42;

const renderButton = () =>
  renderWithProviders(
    <div>
      <HideUserButton userId={TARGET} />
      <span data-testid="anchor">rendered</span>
    </div>
  );

const renderMenuItem = () =>
  renderWithProviders(
    <Menu opened>
      <Menu.Dropdown>
        <HideUserButton userId={TARGET} as="menu-item" />
        <Menu.Item data-testid="anchor">rendered</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

beforeEach(() => {
  mocks.hiddenUsers = [];
  mocks.blockedUsers = [];
  mocks.currentUser = { id: 1 };
  mocks.toggleResult = {};
  mocks.showSuccess.mockClear();
});

describe('HideUserButton — a blocked target is not offered the Hide control', () => {
  test('button variant is absent when the target is blocked', async () => {
    mocks.blockedUsers = [{ id: TARGET }];

    renderButton();

    await expect.element(page.getByTestId('anchor')).toBeInTheDocument();
    expect(page.getByRole('button', { name: /hide/i }).elements()).toHaveLength(0);
  });

  test('menu-item variant is absent when the target is blocked', async () => {
    mocks.blockedUsers = [{ id: TARGET }];

    renderMenuItem();

    await expect.element(page.getByTestId('anchor')).toBeInTheDocument();
    expect(page.getByText(/content from this user/).elements()).toHaveLength(0);
  });

  // Negative control: without these, deleting the whole component body would also
  // make the two assertions above pass.
  test('button variant is present when the target is NOT blocked', async () => {
    renderButton();

    await expect.element(page.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });

  test('menu-item variant is present when the target is NOT blocked', async () => {
    renderMenuItem();

    await expect.element(page.getByText('Hide content from this user')).toBeInTheDocument();
  });

  // The gate reads a React-Query cache that is EMPTY while `getHidden` is in flight,
  // so the control does render on a blocked user on a cold client. The toast is then
  // the last thing that can lie about what happened.
  test('a refused hide reports NOT hidden, not success', async () => {
    mocks.toggleResult = { hidden: false };

    renderButton();

    await page.getByRole('button', { name: 'Hide' }).click();

    await vi.waitFor(() => expect(mocks.showSuccess).toHaveBeenCalled());
    expect(mocks.showSuccess).toHaveBeenCalledTimes(1);
    const { title, message } = mocks.showSuccess.mock.calls[0][0];
    expect(title).toBe('User marked as show');
    expect(message).toContain('will show up in your feed');
  });

  // Negative control: pinning only the refusal would pass with the copy inverted.
  test('a granted hide reports hidden', async () => {
    mocks.toggleResult = { hidden: true };

    renderButton();

    await page.getByRole('button', { name: 'Hide' }).click();

    await vi.waitFor(() => expect(mocks.showSuccess).toHaveBeenCalled());
    expect(mocks.showSuccess).toHaveBeenCalledTimes(1);
    const { title, message } = mocks.showSuccess.mock.calls[0][0];
    expect(title).toBe('User marked as hidden');
    expect(message).toContain('will not show up in your feed');
  });

  // The phantom state this PR cleans up puts the id in BOTH lists at once (an
  // optimistic hide over a block, before onSuccess lands). Gating on `blocked &&
  // !alreadyHiding` passes every other test here and still renders "Unhide".
  test('control is absent when the target is blocked AND in the hidden list', async () => {
    mocks.blockedUsers = [{ id: TARGET }];
    mocks.hiddenUsers = [{ id: TARGET }];

    renderButton();

    await expect.element(page.getByTestId('anchor')).toBeInTheDocument();
    expect(page.getByRole('button', { name: /hide/i }).elements()).toHaveLength(0);
  });

  // A hidden-but-not-blocked target keeps the control, in its Unhide state — the
  // block gate must not be wired to the hidden list by accident.
  test('a hidden target still gets the control, as Unhide', async () => {
    mocks.hiddenUsers = [{ id: TARGET }];

    renderButton();

    await expect.element(page.getByRole('button', { name: 'Unhide' })).toBeInTheDocument();
  });
});

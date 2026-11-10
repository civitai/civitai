import { ModalsProvider } from '@mantine/modals';
import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as NotificationsMod from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';
import { StorylineContextMenu } from '~/components/Storyline/StorylineContextMenu';

/**
 * The storyline page's "..." menu: who is offered "Delete storyline", that it asks first, and that
 * the server's refusal (paid continuations still settling) reaches the person deleting.
 */

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  refusal: null as string | null,
  notify: vi.fn(),
  currentUser: null as { id: number; isModerator?: boolean } | null,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showErrorNotification: mocks.notify,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.delete': {
        useMutation: (opts?: {
          onSuccess?: () => unknown;
          onError?: (error: { message: string }) => unknown;
        }) => ({
          isPending: false,
          mutate: (input: unknown) => {
            mocks.remove(input);
            if (mocks.refusal) void opts?.onError?.({ message: mocks.refusal });
            else void opts?.onSuccess?.();
          },
        }),
      },
    }),
  };
});

const OWNER = 10;
const storyline = { id: 2, title: 'The Long Road', tosViolation: false };

const renderMenu = (props: { isOwner: boolean; tosViolation?: boolean }) =>
  renderWithProviders(
    <ModalsProvider>
      <StorylineContextMenu
        storyline={{ ...storyline, tosViolation: !!props.tosViolation }}
        isOwner={props.isOwner}
      />
    </ModalsProvider>
  );

const openMenu = () => page.getByRole('button', { name: 'More options' }).click();
const deleteItem = () => page.getByRole('menuitem', { name: 'Delete storyline' });

beforeEach(() => {
  mocks.remove.mockReset();
  mocks.notify.mockReset();
  mocks.refusal = null;
  mocks.currentUser = { id: OWNER };
  vi.mocked(useRouter().push).mockClear();
});

describe('StorylineContextMenu', () => {
  test('the owner deletes after a confirm that says the posts stay, then lands on the feed', async () => {
    renderMenu({ isOwner: true });
    await openMenu();
    await deleteItem().click();

    await expect
      .element(page.getByText("Every chapter's post stays published", { exact: false }))
      .toBeVisible();
    expect(mocks.remove).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect(mocks.remove).toHaveBeenCalledWith({ id: 2 });
    await expect.poll(() => vi.mocked(useRouter().push).mock.calls).toEqual([['/storylines']]);
  });

  test('cancelling the confirm deletes nothing', async () => {
    renderMenu({ isOwner: true });
    await openMenu();
    await deleteItem().click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test("a moderator is offered delete on someone else's storyline, beside report", async () => {
    mocks.currentUser = { id: 99, isModerator: true };
    renderMenu({ isOwner: false });
    await openMenu();
    await expect.element(deleteItem()).toBeVisible();
    await expect.element(page.getByRole('menuitem', { name: 'Report storyline' })).toBeVisible();
  });

  test('a reader is offered report only', async () => {
    mocks.currentUser = { id: 99 };
    renderMenu({ isOwner: false });
    await openMenu();
    await expect.element(page.getByRole('menuitem', { name: 'Report storyline' })).toBeVisible();
    expect(deleteItem().query()).toBeNull();
  });

  test('the owner of a taken-down storyline gets no menu, which the server would refuse', async () => {
    const { container } = await renderMenu({ isOwner: true, tosViolation: true });
    // The same render with the storyline up draws the menu, so this absence is the takedown's.
    expect(container.querySelector('button')).toBeNull();
    expect(page.getByRole('button', { name: 'More options' }).query()).toBeNull();
  });

  test('a refusal for unsettled paid continuations is shown, and the page stays', async () => {
    mocks.refusal =
      "This storyline has paid continuations that haven't settled yet. Try again once they have";
    renderMenu({ isOwner: true });
    await openMenu();
    await deleteItem().click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    expect(mocks.notify).toHaveBeenCalledWith({
      title: "Couldn't delete the storyline",
      error: new Error(mocks.refusal),
    });
    expect(useRouter().push).not.toHaveBeenCalled();
  });
});

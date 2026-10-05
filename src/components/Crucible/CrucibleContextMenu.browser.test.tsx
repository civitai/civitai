import { beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; isModerator: boolean },
  openReportModal: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock('~/components/Dialog/triggers/report', () => ({
  openReportModal: mocks.openReportModal,
}));

const { CrucibleContextMenu } = await import('~/components/Crucible/CrucibleContextMenu');

const CREATOR = 4;
const menuButton = () => document.querySelector<HTMLButtonElement>('[aria-label="More options"]');

beforeEach(() => {
  mocks.openReportModal.mockReset();
  // LoginRedirect reads this, not useCurrentUser; without it the report click is swallowed.
  (window as unknown as { isAuthed: boolean }).isAuthed = true;
});

describe('CrucibleContextMenu', () => {
  test("hides itself from the crucible's creator", async () => {
    mocks.currentUser = { id: CREATOR, isModerator: false };
    renderWithProviders(<CrucibleContextMenu crucible={{ id: 17, userId: CREATOR }} />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(menuButton()).toBeNull();
  });

  test.each([
    ['anyone else', { id: 9, isModerator: false }],
    ['a moderator, even on their own crucible', { id: CREATOR, isModerator: true }],
  ])('lets %s report it as a crucible', async (_, user) => {
    mocks.currentUser = user;
    renderWithProviders(<CrucibleContextMenu crucible={{ id: 17, userId: CREATOR }} />);

    await vi.waitFor(() => expect(menuButton()).toBeTruthy());
    menuButton()!.click();
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
          item.textContent?.includes('Report crucible')
        )
      ).toBeTruthy()
    );
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Report crucible'))!
      .click();

    expect(mocks.openReportModal).toHaveBeenCalledWith({ entityType: 'crucible', entityId: 17 });
  });
});

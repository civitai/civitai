import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import {
  FixedSessionProvider,
  SignedOutSessionProvider,
} from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ShowcaseEditButton } from '~/components/Profile/ShowcaseEditButton';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { renderWithProviders } from '../../../test/component-setup';

const OWNER = 7;
const sections = [
  { id: 'a', type: 'Image', title: 'Section a', items: [1] },
  { id: 'b', type: 'Model', title: 'Section b', items: [2] },
];
const profileOf = (extra: Record<string, unknown> = {}) =>
  ({
    id: OWNER,
    username: 'fox',
    profile: { showcaseSections: sections, showcaseItems: [] },
    ...extra,
  } as unknown as ProfileSectionProps['user']);

const trigger = vi.fn();
beforeEach(() => {
  trigger.mockReset();
  vi.spyOn(dialogStore, 'trigger').mockImplementation((dialog) => trigger(dialog));
});

const renderAs = (viewerId: number | null, ui: React.ReactElement) =>
  renderWithProviders(
    viewerId === null ? (
      <SignedOutSessionProvider>{ui}</SignedOutSessionProvider>
    ) : (
      <FixedSessionProvider user={{ id: viewerId, username: 'viewer' }}>{ui}</FixedSessionProvider>
    )
  );

describe("on the owner's own profile", () => {
  test("a custom section's button opens that section's editor", async () => {
    renderAs(OWNER, <ShowcaseEditButton user={profileOf()} sectionId="b" />);
    await userEvent.click(page.getByRole('button', { name: 'Edit section' }));
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].props).toEqual({ sections, sectionId: 'b' });
  });
});

describe('no edit control', () => {
  test.each([
    ['for another signed-in user', OWNER + 1, profileOf()],
    ['for a signed-out visitor', null, profileOf()],
    ['for the owner while the profile is muted', OWNER, profileOf({ muted: true })],
  ])('%s', async (_, viewerId, user) => {
    renderAs(
      viewerId,
      <>
        <span>rendered</span>
        <ShowcaseEditButton user={user} sectionId="a" />
      </>
    );
    // Rendered first, so the missing button is not just a render still to come.
    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('button').elements()).toHaveLength(0);
    expect(trigger).not.toHaveBeenCalled();
  });
});

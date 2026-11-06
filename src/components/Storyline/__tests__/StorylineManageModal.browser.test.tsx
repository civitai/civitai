import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as DataMod from '~/components/Storyline/storyline.data';
import type * as TrpcMod from '~/utils/trpc';
import StorylineManageModal from '~/components/Storyline/manage/StorylineManageModal';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  close: vi.fn(),
  chapterCount: 0,
  tosViolation: false,
  currentUser: { id: 10, username: 'owner' } as {
    id: number;
    username: string;
    isModerator?: boolean;
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const mutation = (spy: (input: unknown) => void) => ({
    useMutation: (opts?: { onSuccess?: () => unknown }) => ({
      isPending: false,
      mutate: (input: unknown) => {
        spy(input);
        void opts?.onSuccess?.();
      },
    }),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': {
        useQuery: () => ({
          data: {
            id: 2,
            userId: 10,
            title: 'A story with no story',
            status: 'Ongoing',
            maxNsfwLevel: 4,
            ownerMaxNsfwLevel: 4,
            whoCanContinue: 'Anyone',
            chapterCount: mocks.chapterCount,
            tosViolation: mocks.tosViolation,
            collaborators: [],
            coverImage: null,
          },
          isLoading: false,
          isError: false,
        }),
      },
      'storyline.update': mutation(mocks.update),
    }),
  };
});
vi.mock('~/components/Storyline/storyline.data', async (importOriginal) => ({
  ...(await importOriginal<typeof DataMod>()),
  useStorylineSpace: () => ({ data: null, unavailable: false, isSaving: false, save: vi.fn() }),
  useStorylineChapterLevels: () => null,
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: mocks.close, zIndex: 300 }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ storylines: true }),
}));
vi.mock('~/components/Storyline/manage/StorylineCoversRow', () => ({
  StorylineCoversRow: () => <div />,
}));
vi.mock('~/components/Storyline/manage/StorylineCollaboratorsPanel', () => ({
  StorylineCollaboratorsPanel: ({ canEndorse }: { canEndorse: boolean }) => (
    <div data-testid="collaborators" data-can-endorse={String(canEndorse)} />
  ),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));

beforeEach(() => {
  for (const fn of [mocks.update, mocks.close]) fn.mockReset();
  vi.mocked(useRouter().push).mockClear();
  mocks.chapterCount = 0;
  mocks.tosViolation = false;
  mocks.currentUser = { id: 10, username: 'owner' };
});

describe('managing a storyline', () => {
  test('saves an edited title, trimmed, and not an unchanged or blank one', async () => {
    renderWithProviders(<StorylineManageModal storylineId={2} />);
    const input = page.getByRole('textbox', { name: 'Title' });
    const save = page.getByRole('button', { name: 'Save' });
    await expect.element(input).toHaveValue('A story with no story');
    await expect.element(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '   ');
    expect(save.element()).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '  The Long Road  ');
    await save.click();
    expect(mocks.update).toHaveBeenCalledWith({ id: 2, title: 'The Long Road' });
  });

  test("lets a moderator edit someone else's storyline, but not delete it or answer its queue", async () => {
    mocks.currentUser = { id: 99, username: 'mod', isModerator: true };
    renderWithProviders(<StorylineManageModal storylineId={2} />);
    const input = page.getByRole('textbox', { name: 'Title' });
    await expect.element(input).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, 'Retitled');
    await page.getByRole('button', { name: 'Save' }).click();
    expect(mocks.update).toHaveBeenCalledWith({ id: 2, title: 'Retitled' });
    expect(page.getByRole('button', { name: 'Delete storyline' }).query()).toBeNull();
    expect(page.getByRole('link', { name: 'Review continuations' }).query()).toBeNull();
    await expect
      .element(page.getByText("Only the storyline's creator can change the price."))
      .toBeVisible();

    await page.getByRole('tab', { name: 'Collaborators' }).click();
    await expect
      .element(page.getByTestId('collaborators'))
      .toHaveAttribute('data-can-endorse', 'false');
  });

  test('refuses anyone else who is not the owner', async () => {
    mocks.currentUser = { id: 99, username: 'reader' };
    renderWithProviders(<StorylineManageModal storylineId={2} />);
    await expect
      .element(page.getByText("Only the storyline's creator can manage it."))
      .toBeVisible();
    expect(page.getByRole('textbox', { name: 'Title' }).query()).toBeNull();
  });
});

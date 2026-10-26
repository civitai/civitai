import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as DataMod from '~/components/Storyline/storyline.data';
import type * as TrpcMod from '~/utils/trpc';
import StorylineManageModal from '~/components/Storyline/manage/StorylineManageModal';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  close: vi.fn(),
  chapterCount: 0,
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
            collaborators: [],
            coverImage: null,
          },
          isLoading: false,
          isError: false,
        }),
      },
      'storyline.update': mutation(mocks.update),
      'storyline.delete': mutation(mocks.remove),
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
  useCurrentUser: () => ({ id: 10, username: 'owner' }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ storylines: true }),
}));
vi.mock('~/components/Storyline/manage/StorylineCoversRow', () => ({
  StorylineCoversRow: () => <div />,
}));
vi.mock('~/components/Storyline/manage/StorylineCollaboratorsPanel', () => ({
  StorylineCollaboratorsPanel: () => <div />,
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));

beforeEach(() => {
  for (const fn of [mocks.update, mocks.remove, mocks.close]) fn.mockReset();
  vi.mocked(useRouter().push).mockClear();
  mocks.chapterCount = 0;
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

  test('deletes an empty storyline after a confirm, then goes to the storylines feed', async () => {
    renderWithProviders(<StorylineManageModal storylineId={2} />);
    await page.getByRole('button', { name: 'Delete storyline' }).click();
    expect(mocks.remove).not.toHaveBeenCalled();
    await expect.element(page.getByText('This cannot be undone', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect(mocks.remove).toHaveBeenCalledWith({ id: 2 });
    await expect.poll(() => vi.mocked(useRouter().push).mock.calls).toEqual([['/storylines']]);
    expect(mocks.close).toHaveBeenCalled();
  });

  test('a storyline with a chapter offers no delete', async () => {
    mocks.chapterCount = 1;
    renderWithProviders(<StorylineManageModal storylineId={2} />);
    await expect.element(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
    expect(page.getByRole('button', { name: 'Delete storyline' }).query()).toBeNull();
  });
});

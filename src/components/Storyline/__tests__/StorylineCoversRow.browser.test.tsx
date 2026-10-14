import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as ImageUtilsMod from '~/components/Image/image.utils';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { StorylineCoversRow } from '~/components/Storyline/manage/StorylineCoversRow';

/**
 * The owner's cover and banner picks: what each slot shows, resetting a pick, and a picker that
 * offers only what the server would accept (chapters by the owner or an endorsed collaborator,
 * within the ceiling, no minors or real people), saving the pick and showing a refusal.
 */

const OWNER = 10;
const COLLABORATOR = 11;
const STRANGER = 12;
const R = 4;
const X = 8;

const chapter = (depth: number, postId: number | null, userId: number) => ({
  chapterId: 100 + depth,
  depth,
  tombstone: postId ? null : 'deleted',
  post: postId ? { id: postId, title: null, userId, username: `u${userId}` } : null,
  childCount: 1,
  firstImage: null,
});

const STORYLINE = {
  id: 2,
  userId: OWNER,
  maxNsfwLevel: R,
  collaborators: [{ id: COLLABORATOR, username: 'collab' }],
  mainPath: [
    chapter(0, 501, OWNER),
    chapter(1, 502, STRANGER),
    chapter(2, null, OWNER),
    chapter(3, 504, COLLABORATOR),
  ],
  coverImage: { id: 1, url: 'chapter-1-first', type: 'image', nsfwLevel: 1 },
  heroImage: { id: 1, url: 'chapter-1-first', type: 'image', nsfwLevel: 1 },
  heroIsBanner: false,
  heroImagePosition: 50,
  coverImageId: null as number | null,
  heroImageId: null as number | null,
};

const img = (id: number, postId: number, extra: Record<string, unknown> = {}) => ({
  id,
  postId,
  url: `img-${id}`,
  type: 'image',
  nsfwLevel: 1,
  minor: false,
  poi: false,
  ...extra,
});

type MutationOptions = {
  onMutate?: () => void;
  onSuccess?: () => unknown;
  onError?: (e: { message: string }) => void;
};

const mocks = vi.hoisted(() => ({
  storyline: undefined as Record<string, unknown> | undefined,
  images: [] as unknown[],
  imageQuery: vi.fn(),
  mutate: vi.fn(),
  refusal: null as string | null,
  invalidateById: vi.fn(async () => undefined),
  invalidateInfinite: vi.fn(async () => undefined),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getById': { useQuery: () => ({ data: mocks.storyline, isLoading: false }) },
        'storyline.update': {
          useMutation: (options: MutationOptions) => ({
            isPending: false,
            mutate: (input: unknown) => {
              mocks.mutate(input);
              options.onMutate?.();
              if (mocks.refusal) options.onError?.({ message: mocks.refusal });
              else void options.onSuccess?.();
            },
          }),
        },
      },
      {
        useUtils: () => ({
          storyline: {
            getById: { invalidate: mocks.invalidateById },
            getInfinite: { invalidate: mocks.invalidateInfinite },
          },
        }),
      }
    ),
  };
});
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtilsMod>()),
  useQueryImages: (input: unknown, options: unknown) => {
    mocks.imageQuery(input, options);
    return { images: mocks.images, isLoading: false, isError: false };
  },
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({
  StorylineThumb: ({
    image,
    children,
  }: {
    image: { url: string } | null;
    children?: React.ReactNode;
  }) => (
    <div data-testid="thumb" data-image={image?.url ?? 'none'}>
      {children}
    </div>
  ),
}));
vi.mock('~/components/Comics/HeroPositionPicker', () => ({
  HeroPositionPicker: ({ url, position }: { url: string; position: number }) => (
    <div data-testid="banner-focus" data-image={url} data-position={String(position)} />
  ),
}));

beforeEach(() => {
  useDialogStore.getState().closeAll();
  mocks.storyline = { ...STORYLINE };
  mocks.images = [];
  mocks.refusal = null;
  for (const fn of [mocks.imageQuery, mocks.mutate, mocks.invalidateById, mocks.invalidateInfinite])
    fn.mockClear();
});

// The picker opens on the dialog stack, as it does inside the Manage modal.
const Row = () => (
  <>
    <StorylineCoversRow storylineId={2} />
    <DialogProvider />
  </>
);
const slot = (name: string) => page.getByRole('group', { name });
/** Per chapter heading, the image urls offered under it. */
const offered = () =>
  [...document.querySelectorAll('[role="radiogroup"]')].map((group) => ({
    chapter: document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent,
    images: [...group.querySelectorAll('[data-testid="thumb"]')].map((t) =>
      t.getAttribute('data-image')
    ),
  }));

describe('StorylineCoversRow', () => {
  test('with nothing picked: the card cover is chapter 1, no banner, nothing to reset', async () => {
    renderWithProviders(<Row />);

    await expect.element(slot('Card cover')).toBeVisible();
    expect(slot('Card cover').getByTestId('thumb').element().getAttribute('data-image')).toBe(
      'chapter-1-first'
    );
    expect(slot('Banner').getByTestId('banner-focus').elements()).toHaveLength(0);
    expect(slot('Banner').element().textContent).toContain(
      'No banner: the page shows the card cover, blurred.'
    );
    expect(page.getByRole('button', { name: 'Use chapter 1' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Remove banner' }).elements()).toHaveLength(0);
  });

  test('a picked banner is shown at its focus, and each pick can be reset', async () => {
    mocks.storyline = {
      ...STORYLINE,
      coverImageId: 30,
      heroImageId: 40,
      coverImage: { id: 30, url: 'cover-pick', type: 'image', nsfwLevel: 1 },
      heroImage: { id: 40, url: 'banner-pick', type: 'image', nsfwLevel: 1 },
      heroIsBanner: true,
      heroImagePosition: 70,
    };
    renderWithProviders(<Row />);

    const focus = slot('Banner').getByTestId('banner-focus');
    await expect.element(focus).toBeInTheDocument();
    expect(focus.element().getAttribute('data-image')).toBe('banner-pick');
    expect(focus.element().getAttribute('data-position')).toBe('70');

    await page.getByRole('button', { name: 'Use chapter 1' }).click();
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: 2, coverImageId: null });
    await page.getByRole('button', { name: 'Remove banner' }).click();
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: 2, heroImageId: null });
    // The page and the feed's card both show the cover.
    expect(mocks.invalidateById).toHaveBeenCalledWith({ id: 2 });
    expect(mocks.invalidateInfinite).toHaveBeenCalled();
  });

  test('the picker offers only images the server would accept, grouped by chapter', async () => {
    mocks.images = [
      img(1, 501),
      img(2, 501, { nsfwLevel: X }), // above the R ceiling
      img(3, 501, { nsfwLevel: 0 }), // not rated yet
      img(4, 504, { nsfwLevel: R }),
      img(5, 504, { minor: true }),
      img(6, 504, { poi: true }),
      img(7, 502), // a stranger's chapter, should the read return it anyway
    ];
    renderWithProviders(<Row />);

    await slot('Card cover').getByRole('button', { name: 'Change' }).click();
    await expect.element(page.getByRole('dialog', { name: 'Choose the card cover' })).toBeVisible();
    // Only the owner's and the collaborator's visible chapters are read.
    expect(mocks.imageQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ postIds: [501, 504] }),
      { enabled: true }
    );
    expect(offered()).toEqual([
      { chapter: 'Chapter 1', images: ['img-1'] },
      { chapter: 'Chapter 4', images: ['img-4'] },
    ]);
  });

  test('picking an image saves it to the slot it was opened for', async () => {
    mocks.images = [img(1, 501), img(4, 504)];
    renderWithProviders(<Row />);

    await slot('Banner').getByRole('button', { name: 'Change' }).click();
    const confirm = page.getByRole('button', { name: 'Use as banner' });
    await expect.element(confirm).toBeDisabled();
    await page.getByRole('radio', { name: 'Chapter 4, image 1' }).click();
    await expect
      .element(page.getByRole('radio', { name: 'Chapter 4, image 1' }))
      .toHaveAttribute('aria-checked', 'true');
    await confirm.click();
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: 2, heroImageId: 4 });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  test('the picker opens on the current pick and does not resend it unchanged', async () => {
    mocks.storyline = { ...STORYLINE, coverImageId: 4 };
    mocks.images = [img(1, 501), img(4, 504)];
    renderWithProviders(<Row />);

    await slot('Card cover').getByRole('button', { name: 'Change' }).click();
    await expect
      .element(page.getByRole('radio', { name: 'Chapter 4, image 1' }))
      .toHaveAttribute('aria-checked', 'true');
    await expect.element(page.getByRole('button', { name: 'Use as card cover' })).toBeDisabled();
    await page.getByRole('radio', { name: 'Chapter 1, image 1' }).click();
    await page.getByRole('button', { name: 'Use as card cover' }).click();
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: 2, coverImageId: 1 });
  });

  test("the server's refusal is shown in the row", async () => {
    mocks.storyline = { ...STORYLINE, coverImageId: 30 };
    mocks.refusal = 'That image cannot be used as a cover';
    renderWithProviders(<Row />);

    await page.getByRole('button', { name: 'Use chapter 1' }).click();
    await expect
      .element(page.getByTestId('storyline-covers-error'))
      .toHaveTextContent('That image cannot be used as a cover');
  });
});

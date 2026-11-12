// The real cascade (layer order first, as `_document.tsx` declares it), so the card surfaces
// compared below are the ones the app renders.
import '../../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { PostEditImageDetail } from '~/server/services/post.service';

const mocks = vi.hoisted(() => ({
  updateImage: vi.fn(),
  deleteImage: vi.fn(),
  showPreview: false,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'post.updateImage': {
        useMutation: () => ({ mutate: mocks.updateImage, isPending: false }),
      },
      'image.delete': {
        useMutation: () => ({ mutateAsync: mocks.deleteImage, isPending: false }),
      },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      images: [],
      updateImage: vi.fn(),
      setImages: vi.fn(),
      post: { id: 1, user: { id: 9 } },
    }),
  usePendingSave: () => undefined,
  usePostPreviewContext: () => ({ showPreview: mocks.showPreview }),
}));
vi.mock('~/hooks/useCurrentUser', async (orig) => ({
  ...(await orig<object>()),
  useCurrentUserRequired: () => ({ id: 9 }),
  useCurrentUser: () => ({ id: 9 }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (orig) => ({
  ...(await orig<object>()),
  EdgeMedia: () => <div data-testid="edge-media" />,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<object>()),
  useFeatureFlags: () => new Proxy({}, { get: () => false }),
}));
vi.mock('~/components/VotableTags/VotableTags', () => ({
  VotableTags: () => <div>votable tags</div>,
}));
vi.mock('~/components/Post/EditV2/Thumbnail/PostImageThumbnailSelect', () => ({
  CurrentThumbnail: () => null,
  PostImageThumbnailSelect: () => null,
}));
vi.mock('~/components/Audio/useAudioPeaks', () => ({ useAudioPeaks: () => null }));

// eslint-disable-next-line import/first
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';
// eslint-disable-next-line import/first
import { useDeletePostImage } from '~/components/Post/EditV2/PostImageCards/useDeletePostImage';

const base = {
  name: 'file',
  hideMeta: false,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  tags: [],
  techniques: [],
  tools: [],
  resourceHelper: [],
};

const song = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    ...base,
    id: 7,
    type: 'audio',
    url: 'song-key',
    meta: { prompt: 'synthwave, neon arcade', seed: 2481930117, steps: 8 },
    metadata: { duration: 192, title: 'Midnight Arcade' },
    resourceHelper: [
      { modelName: 'ACE-Step 1.5', modelVersionName: 'v1', modelType: 'Checkpoint' },
    ],
    lyrics: null,
    ...overrides,
  } as unknown as PostEditImageDetail);

const picture = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    ...base,
    id: 8,
    type: 'image',
    url: 'image-key',
    meta: { prompt: 'a cat on a roof', seed: 42 },
    metadata: { width: 100, height: 100 },
    ...overrides,
  } as unknown as PostEditImageDetail);

const clip = () =>
  picture({ id: 9, type: 'video', metadata: { width: 100, height: 100, duration: 4 } });

function sectionTitles(root: Element) {
  return [...root.querySelectorAll('h3')].map((h) => h.textContent?.trim());
}

async function renderCard(image: PostEditImageDetail) {
  const screen = await renderWithProviders(
    <div data-testid="card">
      <AddedImage image={image} />
    </div>
  );
  await expect.element(page.getByText('Techniques')).toBeVisible();
  return screen.container.querySelector('[data-testid="card"]')!;
}

const openSongMenu = () => userEvent.click(page.getByRole('button', { name: 'Song options' }));

describe('a song in the post editor', () => {
  beforeEach(() => {
    mocks.updateImage.mockReset();
    mocks.deleteImage.mockReset();
    mocks.showPreview = false;
  });

  test('renders in the shared card with its title, source, duration and the shared sections', async () => {
    const card = await renderCard(song());
    await expect
      .element(page.getByRole('textbox', { name: 'Song title' }))
      .toHaveValue('Midnight Arcade');
    await expect.element(page.getByText('Made on Civitai')).toBeVisible();
    await expect.element(page.getByText('ACE-Step 1.5 · 3:12 · seed 2481930117')).toBeVisible();
    await expect.element(page.getByRole('slider', { name: 'Song progress' })).toBeVisible();
    expect(sectionTitles(card)).toEqual(['Prompt', 'Resources', 'Tools', 'Techniques']);
    await expect.element(page.getByText('synthwave, neon arcade')).toBeVisible();
    expect(card.querySelector('img, [data-testid="edge-media"]')).toBeNull();
  });

  test('has the same surface as an image card and no gradient or tint', async () => {
    const screen = await renderWithProviders(
      <>
        <div data-testid="image">
          <AddedImage image={picture()} />
        </div>
        <div data-testid="song">
          <AddedImage image={song()} />
        </div>
      </>
    );
    await expect.element(page.getByRole('textbox', { name: 'Song title' })).toBeVisible();
    const surface = (testId: string) => {
      const root = screen.container.querySelector(`[data-testid="${testId}"]`)!.firstElementChild!;
      const css = getComputedStyle(root);
      return [
        css.backgroundColor,
        css.backgroundImage,
        css.borderTopWidth,
        css.borderTopStyle,
        css.borderTopColor,
        css.borderRadius,
      ];
    };
    expect(surface('song')).toEqual(surface('image'));
    const songCard = screen.container.querySelector('[data-testid="song"]')!;
    const gradients = [songCard, ...songCard.querySelectorAll('*')].filter((el) =>
      getComputedStyle(el).backgroundImage.includes('gradient')
    );
    expect(gradients).toHaveLength(0);
  });

  test('the preview tab shows the song player and no image render', async () => {
    mocks.showPreview = true;
    const screen = await renderWithProviders(<AddedImage image={song()} />);
    await expect.element(page.getByRole('slider', { name: 'Song progress' })).toBeVisible();
    await expect.element(page.getByText('Edit details')).toBeVisible();
    expect(screen.container.querySelector('img, [data-testid="edge-media"]')).toBeNull();
  });

  test('hides the sections that cannot apply to a song', async () => {
    const card = await renderCard(song());
    expect(sectionTitles(card)).not.toContain('Thumbnail');
    await expect.element(page.getByText('PG', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('votable tags')).not.toBeInTheDocument();
    await expect.element(page.getByText('Seed', { exact: true })).not.toBeInTheDocument();
    await openSongMenu();
    await expect.element(page.getByRole('menuitem', { name: 'Delete song' })).toBeVisible();
    await expect
      .element(page.getByRole('menuitem', { name: 'Edit image' }))
      .not.toBeInTheDocument();
  });

  test('an untitled song invites a title', async () => {
    await renderCard(song({ metadata: { duration: 192 } }));
    await expect
      .element(page.getByRole('textbox', { name: 'Song title' }))
      .toHaveAttribute('placeholder', 'Untitled song');
  });

  // react-textarea-autosize's development build throws on an inline min/max height, which
  // crashed the edit page in dev. It cannot throw here: the deps pre-bundle replaces
  // `process.env.NODE_ENV` with "test" and Mantine's Textarea then renders a plain <textarea>.
  // The inline style below is the exact `style` prop the autosizer receives in the app.
  test('the title passes no inline height for the autosizing textarea to refuse', async () => {
    await renderCard(song());
    const { style } = page.getByRole('textbox', { name: 'Song title' }).element() as HTMLElement;
    expect({ minHeight: style.minHeight, maxHeight: style.maxHeight }).toEqual({
      minHeight: '',
      maxHeight: '',
    });
  });

  test('editing the title saves it to the song', async () => {
    await renderCard(song());
    const title = page.getByRole('textbox', { name: 'Song title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Neon Rain');
    await userEvent.tab();
    expect(mocks.updateImage).toHaveBeenLastCalledWith({ id: 7, title: 'Neon Rain' });
  });

  test('shows the lyrics read-only, with times only on timed lines', async () => {
    await renderCard(
      song({
        lyrics: [
          { t: null, text: '[Verse 1]' },
          { t: 12000, text: 'Coins in the slot, the city hums in blue' },
        ],
      })
    );
    await expect.element(page.getByText('[Verse 1]')).toBeVisible();
    await expect.element(page.getByText('Coins in the slot, the city hums in blue')).toBeVisible();
    await expect.element(page.getByText('0:12')).toBeVisible();
    await expect
      .element(page.getByText("Locked · the generator's timestamps drive synced lyrics"))
      .toBeVisible();
    expect(page.getByRole('textbox').all()).toHaveLength(1);
  });

  test('a song without lyrics shows no lyrics block', async () => {
    await renderCard(song());
    await expect.element(page.getByText('Lyrics', { exact: true })).not.toBeInTheDocument();
  });

  test('has one Hide prompt control, with the song description, that saves hideMeta', async () => {
    await renderCard(song({ meta: { seed: 1 } }));
    const hide = page.getByRole('button', { name: /hide prompt/i });
    expect(hide.all()).toHaveLength(1);
    expect(page.getByRole('switch', { name: /hide prompt/i }).all()).toHaveLength(0);
    await expect
      .element(hide)
      .toHaveAccessibleDescription(
        'Hides the style prompt, lyrics prompt and seed, and removes Remix this recipe. Lyrics stay visible.'
      );
    await userEvent.click(hide);
    expect(mocks.updateImage).toHaveBeenLastCalledWith({ id: 7, hideMeta: true });
  });

  test('remixes are allowed by default, and turning them off saves allowRemix', async () => {
    await renderCard(song());
    const allow = page.getByRole('switch', { name: 'Allow remixes' });
    await expect.element(allow).toBeChecked();
    await expect
      .element(page.getByText("Others can use this song's recipe in the generator."))
      .toBeVisible();
    // Mantine hides the switch's input behind its track; the label is what a user clicks.
    await userEvent.click(page.getByText('Allow remixes', { exact: true }));
    expect(mocks.updateImage).toHaveBeenLastCalledWith({ id: 7, allowRemix: false });
  });

  test('removing a song asks to delete the song', async () => {
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    try {
      await renderCard(song());
      await openSongMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Delete song' }));
      expect(trigger.mock.calls[0][0].props).toMatchObject({
        title: 'Delete song',
        message: 'Are you sure you want to delete this song?',
      });
    } finally {
      trigger.mockRestore();
    }
  });
});

describe('image and video cards next to songs', () => {
  beforeEach(() => {
    mocks.showPreview = false;
  });

  async function openImageMenu(card: Element) {
    const target = card.querySelector('.tabler-icon-dots-vertical')!.closest('button')!;
    await userEvent.click(target);
  }

  test('an image card keeps its sections, rating, tags and menu', async () => {
    const card = await renderCard(picture());
    expect(sectionTitles(card)).toEqual(['Prompt', 'Resources', 'Tools', 'Techniques']);
    expect(card.querySelectorAll('[data-testid="edge-media"]')).toHaveLength(1);
    await expect.element(page.getByText('PG', { exact: true })).toBeVisible();
    await expect.element(page.getByText('votable tags')).toBeVisible();
    await expect.element(page.getByText('Seed', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'HIDE PROMPT' })).toBeVisible();
    await expect.element(page.getByRole('textbox', { name: 'Song title' })).not.toBeInTheDocument();
    await openImageMenu(card);
    await expect.element(page.getByRole('menuitem', { name: 'Edit image' })).toBeVisible();
    await expect.element(page.getByRole('menuitem', { name: 'Delete image' })).toBeVisible();
  });

  test('a video card keeps its sections, thumbnail picker included', async () => {
    const card = await renderCard(clip());
    expect(sectionTitles(card)).toEqual([
      'Prompt',
      'Resources',
      'Tools',
      'Techniques',
      'Thumbnail',
    ]);
    expect(card.querySelectorAll('[data-testid="edge-media"]')).toHaveLength(1);
    await expect.element(page.getByText('votable tags')).toBeVisible();
    await expect
      .element(page.getByRole('slider', { name: 'Song progress' }))
      .not.toBeInTheDocument();
  });

  test('removing an image keeps the image copy', async () => {
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    function ImageRemove() {
      const { onDelete } = useDeletePostImage(8, 'image');
      return <button onClick={onDelete}>Remove</button>;
    }
    try {
      await renderWithProviders(<ImageRemove />);
      await userEvent.click(page.getByRole('button', { name: 'Remove' }));
      expect(trigger.mock.calls[0][0].props).toMatchObject({
        title: 'Delete image',
        message: 'Are you sure you want to delete this image?',
      });
    } finally {
      trigger.mockRestore();
    }
  });
});

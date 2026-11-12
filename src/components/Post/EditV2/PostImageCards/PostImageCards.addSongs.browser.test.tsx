// The real cascade (layer order first, as `_document.tsx` declares it), so the button's
// computed border is the one the app renders.
import '../../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';

const mocks = vi.hoisted(() => ({
  images: [] as unknown[],
  music: true,
  open: vi.fn(),
  setView: vi.fn(),
}));

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) => selector({ images: mocks.images }),
  usePostPreviewContext: () => ({ showPreview: false, toggleShowPreview: vi.fn() }),
}));
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({ maxItems: 20 }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<object>()),
  useFeatureFlags: () => ({ music: mocks.music }),
}));
vi.mock('~/store/generation-graph.store', () => ({
  generationGraphPanel: { open: mocks.open, setView: mocks.setView },
}));
vi.mock('~/components/Post/EditV2/PostImageCards/AddedImage', () => ({
  AddedImage: ({ image }: { image: { type: string } }) => (
    <div>{image.type === 'audio' ? 'song card' : 'image card'}</div>
  ),
}));

// eslint-disable-next-line import/first
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards/PostImageCards';

const added = (id: number, type: 'image' | 'audio') => ({
  type: 'added',
  data: { id, type, url: `u${id}`, index: id },
});
const addSongs = () => page.getByRole('button', { name: 'Add songs from the generator' });

describe('adding more songs to a post', () => {
  beforeEach(() => {
    mocks.open.mockReset();
    mocks.setView.mockReset();
    mocks.music = true;
  });

  test('a post with a song opens the generator queue', async () => {
    mocks.images = [added(1, 'image'), added(2, 'audio')];
    renderWithProviders(<PostImageCards />);
    await userEvent.click(addSongs());
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.setView).toHaveBeenCalledWith('queue');
  });

  test('the button has a 1px outline in the strong border colour in both schemes', async () => {
    mocks.images = [added(2, 'audio')];
    renderWithProviders(
      <>
        <div data-testid="light">
          <PostImageCards />
        </div>
        <div data-testid="dark" data-mantine-color-scheme="dark">
          <PostImageCards />
        </div>
      </>
    );
    const border = async (scheme: string) => {
      const button = page.getByTestId(scheme).getByRole('button', {
        name: 'Add songs from the generator',
      });
      await expect.element(button).toBeVisible();
      const css = getComputedStyle(button.element());
      return [css.borderTopWidth, css.borderTopStyle, css.borderTopColor];
    };
    expect(await border('light')).toEqual(['1px', 'solid', 'rgb(206, 212, 218)']);
    expect(await border('dark')).toEqual(['1px', 'solid', 'rgb(92, 95, 102)']);
  });

  test('a post without songs has no button', async () => {
    mocks.images = [added(1, 'image')];
    renderWithProviders(<PostImageCards />);
    await expect.element(page.getByText('image card')).toBeVisible();
    await expect.element(addSongs()).not.toBeInTheDocument();
  });

  test('without the music flag there is no button', async () => {
    mocks.music = false;
    mocks.images = [added(2, 'audio')];
    renderWithProviders(<PostImageCards />);
    await expect.element(page.getByText('song card')).toBeVisible();
    await expect.element(addSongs()).not.toBeInTheDocument();
  });
});

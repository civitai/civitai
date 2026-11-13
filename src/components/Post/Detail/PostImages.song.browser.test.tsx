// The real cascade, so the tile lays out as on the site.
import '../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';

// Browser mode only: the song tile and its menu render real Mantine.

const mocks = vi.hoisted(() => ({
  features: { music: true } as Record<string, boolean>,
  menuProps: [] as { imageId: number; leading: unknown }[],
  menuOpened: false,
}));

const audio = (id: number, title?: string) => ({
  id,
  type: 'audio',
  url: `song-${id}.mp3`,
  name: null,
  width: null,
  height: null,
  hasMeta: false,
  metadata: { duration: 200, ...(title && { title }) },
  reactions: [],
  stats: {},
  user: { id: 9, username: 'neonwave' },
  eventDecoration: null,
});
const picture = (id: number) => ({
  ...audio(id),
  type: 'image',
  url: `img-${id}.jpeg`,
  width: 600,
  height: 400,
  metadata: {},
});

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => mocks.features,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import(
    '~/components/MusicPlayer/__tests__/song-covers-trpc-stub'
  );
  return {
    ...actual,
    trpc: withSongCoversStub(actual.trpc),
  };
});
vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUserSettings: () => ({}),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ type, imageId }: any) =>
    imageId == null ? null : <div data-testid={`media-${type}`} />,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: any) => <>{children(true)}</>;
  ImageGuard2.BlurToggle = function BlurToggle() {
    return <span data-testid="rating">PG</span>;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RoutedDialogLink: ({ children }: any) => <a>{children}</a>,
}));
vi.mock('~/components/Sticker/StickerPlacementBatchProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  StickerPlacementBatchProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('~/components/Ads/AdUnit', () => ({ AdUnitTop: () => null }));
vi.mock('~/components/ImageHash/ImageHash', () => ({ MediaHash: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', async () => {
  const { Menu } = await import('~/components/MantineOverlays');
  return {
    ImageContextMenu: ({ image, leadingMenuItems }: any) => {
      mocks.menuProps.push({ imageId: image.id, leading: leadingMenuItems });
      return leadingMenuItems ? (
        <Menu opened={mocks.menuOpened} withinPortal={false}>
          <Menu.Target>
            <button type="button">Menu {image.id}</button>
          </Menu.Target>
          <Menu.Dropdown>
            {leadingMenuItems}
            <Menu.Item>Report</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : null;
    },
  };
});
vi.mock('~/components/Image/Meta/ImageMetaPopover', () => ({ ImageMetaPopover2: () => null }));
vi.mock('~/components/Post/Detail/PostContestCollectionInfoAlert', () => ({
  PostContestCollectionInfoAlert: () => null,
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { PostImages } from '~/components/Post/Detail/PostImages';
import { useMusicPlayerStore } from '~/store/music-player.store';

const player = () => useMusicPlayerStore.getState();
const ids = (tracks: { id: number }[]) => tracks.map((t) => t.id);
const post = [audio(1, 'Midnight Arcade'), picture(2), audio(3), audio(4, 'Palm Static')];

beforeEach(() => {
  mocks.features = { music: true };
  mocks.menuProps = [];
  mocks.menuOpened = false;
  player().close();
});

describe('a song on the post page', () => {
  test('with the music flag, plays in the global player with the post songs as the list', async () => {
    await renderWithProviders(
      <PostImages postId={100} postTitle="Night Drive" images={post as any} />
    );

    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    await expect.element(page.getByText('Untitled song')).toBeInTheDocument();
    expect(page.getByText('3:20').elements()).toHaveLength(3);
    expect(page.getByTestId('media-audio').elements()).toHaveLength(0);
    // The picture in the same post renders as before.
    await expect.element(page.getByTestId('media-image')).toBeInTheDocument();

    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    expect(player().current?.id).toBe(1);
    expect(player().playing).toBe(true);
    expect(player().listName).toBe('Night Drive');
    expect(ids(player().list)).toEqual([3, 4]);
    await expect
      .element(page.getByRole('button', { name: 'Pause Midnight Arcade' }))
      .toBeInTheDocument();

    await page.getByRole('button', { name: 'Pause Midnight Arcade' }).click();
    expect(player().playing).toBe(false);
  });

  test('a song in the middle of the post: Up next is the songs after it', async () => {
    await renderWithProviders(
      <PostImages postId={100} postTitle="Night Drive" images={post as any} />
    );
    await page.getByRole('button', { name: 'Play Untitled song' }).click();
    expect(player().current?.id).toBe(3);
    expect(player().listName).toBe('Night Drive');
    expect(ids(player().list)).toEqual([4]);
  });

  test('a post with one song leaves Up next empty', async () => {
    await renderWithProviders(
      <PostImages
        postId={100}
        postTitle="Night Drive"
        images={[audio(1, 'Midnight Arcade'), picture(2)] as any}
      />
    );
    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    expect(player().current?.id).toBe(1);
    expect(player().list).toEqual([]);
  });

  test('the song menu plays now, plays next and adds to up next; pictures get no song items', async () => {
    mocks.menuOpened = true;
    await renderWithProviders(
      <PostImages postId={100} postTitle="Night Drive" images={post as any} />
    );
    await expect.element(page.getByText('Midnight Arcade')).toBeInTheDocument();
    expect(mocks.menuProps.filter((p) => p.imageId === 2).every((p) => !p.leading)).toBe(true);

    const items = (name: string) => page.getByRole('menuitem', { name, exact: true }).elements();
    expect(items('Play now')).toHaveLength(3);
    (items('Play now')[2] as HTMLElement).click();
    expect(player().current?.id).toBe(4);

    (items('Add to up next')[0] as HTMLElement).click();
    (items('Play next')[1] as HTMLElement).click();
    expect(ids(player().queued)).toEqual([3, 1]);
  });

  test('at phone width the tile fits its title beside a 64px cover that carries the rating', async () => {
    await page.viewport(390, 800);
    await renderWithProviders(
      <div className="px-4">
        <PostImages
          postId={100}
          postTitle="Night Drive"
          images={[audio(1, 'Paper Lanterns')] as any}
        />
      </div>
    );
    const title = page.getByText('Paper Lanterns');
    await expect.element(title).toBeVisible();
    expect(title.element().scrollWidth).toBeLessThanOrEqual(title.element().clientWidth);

    const cover = page.getByTestId('music-cover-placeholder').element()
      .parentElement as HTMLElement;
    const coverBox = cover.getBoundingClientRect();
    expect(coverBox.width).toBe(64);
    const rating = page.getByTestId('rating').element().getBoundingClientRect();
    expect(rating.left).toBeGreaterThanOrEqual(coverBox.left);
    expect(rating.top).toBeGreaterThanOrEqual(coverBox.top);
    expect(rating.right).toBeLessThanOrEqual(coverBox.right);
    expect(rating.bottom).toBeLessThanOrEqual(coverBox.bottom);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test('the play button names itself in a tooltip', async () => {
    await renderWithProviders(
      <PostImages
        postId={100}
        postTitle="Night Drive"
        images={[audio(1, 'Paper Lanterns')] as any}
      />
    );
    await userEvent.hover(page.getByRole('button', { name: 'Play Paper Lanterns' }));
    await expect.element(page.getByRole('tooltip', { name: 'Play' })).toBeVisible();
  });

  test('the song items are the same size as the rest of the menu', async () => {
    mocks.menuOpened = true;
    await renderWithProviders(
      <PostImages
        postId={100}
        postTitle="Night Drive"
        images={[audio(1, 'Paper Lanterns')] as any}
      />
    );
    const size = (name: string) =>
      getComputedStyle(page.getByRole('menuitem', { name, exact: true }).element()).fontSize;
    await expect.element(page.getByRole('menuitem', { name: 'Report' })).toBeInTheDocument();
    for (const name of ['Play now', 'Add to up next', 'Play next'])
      expect(size(name)).toBe(size('Report'));
  });

  test('with the flag off, a song renders the native element as before', async () => {
    mocks.features = {};
    await renderWithProviders(
      <PostImages postId={100} postTitle="Night Drive" images={post as any} />
    );
    await expect.element(page.getByTestId('media-image')).toBeInTheDocument();
    expect(page.getByTestId('media-audio').elements()).toHaveLength(3);
    expect(page.getByRole('button', { name: /^Play / }).elements()).toHaveLength(0);
    expect(mocks.menuProps.every((p) => !p.leading)).toBe(true);
  });
});

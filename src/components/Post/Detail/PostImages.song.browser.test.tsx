import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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
  return {
    ...actual,
    trpc: new Proxy(actual.trpc, {
      get: (target, key) =>
        key === 'image'
          ? { getSongCovers: { useQuery: () => ({ data: [] }) } }
          : key === 'post'
          ? { get: { useQuery: () => ({ data: { id: 100, title: 'Night Drive' } }) } }
          : Reflect.get(target, key),
    }),
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
    return null;
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
          <Menu.Dropdown>{leadingMenuItems}</Menu.Dropdown>
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
    await renderWithProviders(<PostImages postId={100} images={post as any} />);

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

  test('a post with one song passes no list', async () => {
    await renderWithProviders(
      <PostImages postId={100} images={[audio(1, 'Midnight Arcade'), picture(2)] as any} />
    );
    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    expect(player().current?.id).toBe(1);
    expect(player().listName).toBeNull();
    expect(player().list).toEqual([]);
  });

  test('the song menu plays now, plays next and adds to up next; pictures get no song items', async () => {
    mocks.menuOpened = true;
    await renderWithProviders(<PostImages postId={100} images={post as any} />);
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

  test('with the flag off, a song renders the native element as before', async () => {
    mocks.features = {};
    await renderWithProviders(<PostImages postId={100} images={post as any} />);
    await expect.element(page.getByTestId('media-image')).toBeInTheDocument();
    expect(page.getByTestId('media-audio').elements()).toHaveLength(3);
    expect(page.getByRole('button', { name: /^Play / }).elements()).toHaveLength(0);
    expect(mocks.menuProps.every((p) => !p.leading)).toBe(true);
  });
});

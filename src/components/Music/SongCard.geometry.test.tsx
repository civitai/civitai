import type { ReactNode } from 'react';
import { useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as AdsUtils from '~/components/Ads/ads.utils';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';

vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProvider>()),
  useAdsContext: () => ({ adsEnabled: false, useDirectAds: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Ads/ads.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsUtils>()),
  useCreateAdFeed: () => (args: { data: unknown[] }) =>
    args.data.map((item) => ({ type: 'data' as const, data: item })),
}));
// Covers are a separate read; every song here shows the fallback art.
vi.mock('~/components/MusicPlayer/useMusicPlayerCover', () => ({
  useMusicPlayerCovers: () => new Map(),
  useSongListCovers: () => new Map(),
}));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#song" className={className}>
      {children}
    </a>
  ),
}));

import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { SongCard } from '~/components/Music/SongCard';
import {
  MUSIC_FEED_COLUMN_WIDTH,
  SONG_CARD_TEXT_HEIGHT,
  SONG_COVER_RATIO,
} from '~/components/Music/song-card.constants';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import type { ImagesInfiniteModel } from '~/server/services/image.service';

const song = (id: number, title: string) =>
  ({
    id,
    url: `song-${id}.mp3`,
    type: 'audio',
    metadata: { title, duration: 185, genre: 'Synthwave' },
    user: { id: 100 + id, username: `artist${id}` },
    stats: { likeCountAllTime: 3, commentCountAllTime: 1 },
  } as unknown as ImagesInfiniteModel);
const songs = [song(1, 'Midnight Arcade'), song(2, 'Palm Static')];

const title = (name: string) =>
  [...document.querySelectorAll('a')].find((a) => a.textContent === name)!;
const cardOf = (el: Element) => el.parentElement!;

const feedSizing = {
  imageDimensions: () => ({ width: 1000, height: 1000 * SONG_COVER_RATIO }),
  adjustHeight: ({ height }: { height: number }) => height + SONG_CARD_TEXT_HEIGHT,
  itemId: (data: ImagesInfiniteModel) => data.id,
};

// The music feed at phone width: one column, as wide as the page allows.
function PhoneFeed() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div ref={scrollRef} style={{ height: PHONE_VIEWPORT.height, overflowY: 'auto' }}>
        <MasonryProvider columnWidth={MUSIC_FEED_COLUMN_WIDTH} px={16}>
          <MasonryColumnsVirtual data={songs} render={SongCard} {...feedSizing} />
        </MasonryProvider>
      </div>
    </ScrollAreaContext.Provider>
  );
}

describe('the Song Card at phone width', () => {
  test('the feed sizes the card for the width it is drawn at, so the title shows', async () => {
    await renderAtViewport(<PhoneFeed />, PHONE_VIEWPORT);
    await vi.waitFor(() => expect(title('Palm Static')).toBeTruthy());
    const card = cardOf(title('Palm Static')).getBoundingClientRect();
    expect(card.width).toBe(PHONE_VIEWPORT.width - 32);
    expect(card.height).toBe(Math.floor(card.width * SONG_COVER_RATIO + SONG_CARD_TEXT_HEIGHT));
    expect(title('Palm Static').getBoundingClientRect().height).toBe(20);
  });

  test('a slot shorter than the card shrinks the cover, never the text', async () => {
    await renderAtViewport(
      <div style={{ width: 358 }}>
        <SongCard data={songs[0]} height={300} />
      </div>,
      PHONE_VIEWPORT
    );
    const card = cardOf(title('Midnight Arcade'));
    const [cover] = card.children;
    expect(title('Midnight Arcade').getBoundingClientRect().height).toBe(20);
    expect(card.lastElementChild!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      card.getBoundingClientRect().bottom
    );
    expect(cover.getBoundingClientRect().height).toBe(300 - SONG_CARD_TEXT_HEIGHT);
  });
});

test('the music feed lays Song Cards six across at 1440 (Pencil `xNZ0Z`)', async () => {
  const many = Array.from({ length: 8 }, (_, i) => song(i + 1, `Song ${i + 1}`));
  function DesktopFeed() {
    const scrollRef = useRef<HTMLDivElement>(null);
    return (
      <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
        <div ref={scrollRef} style={{ height: 900, overflowY: 'auto' }}>
          <MasonryProvider columnWidth={MUSIC_FEED_COLUMN_WIDTH}>
            <MasonryContainer columnWidth={MUSIC_FEED_COLUMN_WIDTH}>
              <MasonryColumnsVirtual data={many} render={SongCard} {...feedSizing} />
            </MasonryContainer>
          </MasonryProvider>
        </div>
      </ScrollAreaContext.Provider>
    );
  }
  await renderAtViewport(<DesktopFeed />, { width: 1440, height: 900 });
  await vi.waitFor(() => expect(title('Song 6')).toBeTruthy());
  const cards = many.slice(0, 6).map((s) => cardOf(title(`Song ${s.id}`)).getBoundingClientRect());
  expect(new Set(cards.map((c) => Math.round(c.top))).size).toBe(1);
  expect(cards.map((c) => c.width)).toEqual(Array(6).fill(MUSIC_FEED_COLUMN_WIDTH));
});

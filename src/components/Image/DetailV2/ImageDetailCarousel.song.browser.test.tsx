import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as SongDetailStageModule from '~/components/Music/SongDetail/SongDetailStage';
import { renderWithProviders } from '../../../../test/component-setup';

const state = vi.hoisted(() => ({ music: true, safe: true }));

vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({ children }: { children: (safe: boolean) => ReactNode }) => (
    <>{children(state.safe)}</>
  ),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (o) => ({
  ...(await o<object>()),
  EdgeMedia: () => <div data-testid="edge-media" />,
}));
vi.mock('~/components/Music/SongDetail/SongDetailStage', async (importOriginal) => ({
  ...(await importOriginal<typeof SongDetailStageModule>()),
  SongDetailStage: ({ revealed }: { revealed: boolean }) => (
    <div data-testid="song-stage" data-revealed={String(revealed)} />
  ),
}));
vi.mock('~/components/Sticker/ImageStickerOverlay', async (o) => ({
  ...(await o<object>()),
  ImageStickerOverlay: () => null,
}));
vi.mock('~/components/Cosmetics/EventDecoration/DrawnMediaHat', async (o) => ({
  ...(await o<object>()),
  DrawnMediaHat: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (o) => ({
  ...(await o<object>()),
  useFeatureFlags: () => ({ music: state.music }),
}));

import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';

const songImage = {
  id: 1,
  nsfwLevel: 1,
  url: 'song-1.mp3',
  height: null,
  width: null,
  type: 'audio' as const,
  name: null,
  metadata: { title: 'Midnight Arcade', duration: 178 },
  user: { id: 2, username: 'neonwave' },
};

function renderCarousel() {
  return renderWithProviders(
    <div style={{ width: 800, height: 600, display: 'flex' }}>
      <ImageDetailCarousel
        images={[songImage]}
        index={0}
        canNavigate={false}
        next={() => undefined}
        previous={() => undefined}
      />
    </div>
  );
}

beforeEach(() => {
  state.music = true;
  state.safe = true;
});

describe('a song slide in the detail carousel', () => {
  test('is the song stage with the music flag on, revealed by the guard', async () => {
    await renderCarousel();
    await expect.element(page.getByTestId('song-stage')).toHaveAttribute('data-revealed', 'true');
    expect(document.querySelector('[data-testid="edge-media"]')).toBeNull();
  });

  test('stays unrevealed while the guard blurs it', async () => {
    state.safe = false;
    await renderCarousel();
    await expect.element(page.getByTestId('song-stage')).toHaveAttribute('data-revealed', 'false');
  });

  test('is today’s media with the flag off', async () => {
    state.music = false;
    await renderCarousel();
    await expect.element(page.getByTestId('edge-media')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="song-stage"]')).toBeNull();
  });
});

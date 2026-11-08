import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as TrpcModule from '~/utils/trpc';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import type { StickerTrack } from '~/shared/utils/sticker-track';
import { encodeStickerTrack, momentStickerTrack } from '~/shared/utils/sticker-track';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

const { tracksQuery } = vi.hoisted(() => ({ tracksQuery: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../test/trpcProxyStub')).makeTrpcProxy({
    'placement.getStickerTracks': { useQuery: tracksQuery },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useStickerCosmetics: () => ({ sticker: new Map() }),
}));
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ src, alt, style }: { src: string; alt: string; style?: object }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a fixture, not app markup.
    <img src={src} alt={alt} style={style} />
  ),
}));
vi.mock('~/components/Sticker/StickerPlacementHoverCard', () => ({
  StickerPlacementHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { StickerPlacementOverlay } = await import('~/components/Sticker/StickerPlacementOverlay');
const { useTrackPlayback } = await import('~/components/Sticker/useTrackPlayback');

const IMAGE_ID = 74;
const sticker = new Map([[9, { id: 9, name: 'Test', slug: 'test', url: PNG }]]);
const start = { x: 0.2, y: 0.3, scale: 0.2, rotation: 0 };

const placed: PlacedSticker = {
  id: 1,
  imageId: IMAGE_ID,
  placerId: 3,
  ownerId: 99,
  status: 'Accepted',
  amount: 0,
  free: true,
  hasComment: false,
  isPending: false,
  placedAt: new Date(0),
  data: { cosmeticId: 9, ...start, flip: false, opacity: 1 },
} as PlacedSticker;

/** Ten ticks (one second) from the start pose to x 0.8, y 0.7, scale 0.3, rotation 90. */
const path: StickerTrack = encodeStickerTrack(
  Array.from({ length: 11 }, (_, tick) => ({
    x: 0.2 + 0.06 * tick,
    y: 0.3 + 0.04 * tick,
    scale: 0.2 + 0.01 * tick,
    rotation: 9 * tick,
  }))
);

function Harness() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [mounted, setMounted] = useState(true);
  const [renders, setRenders] = useState(0);
  const { hiddenIds, bindPose } = useTrackPlayback(IMAGE_ID, video);
  return (
    <div style={{ position: 'relative', width: 400, height: 400 }}>
      <video ref={setVideo} data-testid="media" />
      <button onClick={() => setRenders(renders + 1)}>Render {renders}</button>
      <button onClick={() => setMounted(!mounted)}>Toggle</button>
      {video && (
        <StickerPlacementOverlay
          placements={mounted ? [placed] : []}
          viewerId={99}
          sticker={sticker as never}
          hiddenIds={hiddenIds}
          bindPose={bindPose}
        />
      )}
    </div>
  );
}

const render = async (track: StickerTrack, startSeconds = 0) => {
  tracksQuery.mockReturnValue({ data: [{ id: 1, track }] });
  let time = startSeconds;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: () => time,
  });
  renderWithProviders(<Harness />);
  await expect.element(page.getByAltText(':test:')).toBeInTheDocument();
  const video = page.getByTestId('media').element() as HTMLVideoElement;
  const box = () =>
    (page.getByAltText(':test:').element() as HTMLElement).closest<HTMLElement>('.absolute')!;
  return {
    box,
    left: () => parseFloat(box().style.left),
    setTime: (seconds: number) => {
      time = seconds;
    },
    seek: (seconds: number) => {
      time = seconds;
      video.dispatchEvent(new Event('seeked'));
    },
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLMediaElement.prototype as { currentTime?: number }).currentTime;
});

describe('a recorded sticker moves with the video', () => {
  test('follows its path as the video seeks, forward and back', async () => {
    const { box, left, seek } = await render(path);

    seek(0.5);
    expect(left()).toBeCloseTo(50);
    expect(parseFloat(box().style.top)).toBeCloseTo(50);
    expect(parseFloat(box().style.width)).toBeCloseTo(25);
    expect(box().style.transform).toBe('translate(-50%, -50%) rotate(45deg)');

    seek(1);
    expect(left()).toBeCloseTo(80);

    seek(0);
    expect(left()).toBeCloseTo(20);
  });

  test('moves on each video frame while it plays', async () => {
    let onFrame: (() => void) | undefined;
    vi.spyOn(HTMLVideoElement.prototype, 'requestVideoFrameCallback').mockImplementation(
      (callback) => {
        onFrame = callback as unknown as () => void;
        return 7;
      }
    );
    const { left, setTime } = await render(path);

    setTime(0.5);
    onFrame?.();
    expect(left()).toBeCloseTo(50);
    setTime(1);
    onFrame?.();
    expect(left()).toBeCloseTo(80);
  });

  test('keeps its pose through a re-render', async () => {
    const { left, seek } = await render(path);
    seek(0.5);

    // The DOM click: the overlay covers the harness's buttons.
    (page.getByRole('button', { name: 'Render 0' }).element() as HTMLElement).click();
    await expect.element(page.getByRole('button', { name: 'Render 1' })).toBeInTheDocument();

    expect(left()).toBeCloseTo(50);
  });

  test('a sticker that mounts while the video is paused mid-path starts where the path is', async () => {
    const { seek } = await render(path);
    (page.getByRole('button', { name: 'Toggle' }).element() as HTMLElement).click();
    await expect.element(page.getByAltText(':test:')).not.toBeInTheDocument();
    // Moved while nothing is mounted, so only the mount itself can pose the sticker that arrives.
    seek(0.5);

    (page.getByRole('button', { name: 'Toggle' }).element() as HTMLElement).click();
    await expect.element(page.getByAltText(':test:')).toBeInTheDocument();
    const box = (page.getByAltText(':test:').element() as HTMLElement).closest<HTMLElement>(
      '.absolute'
    )!;
    expect(parseFloat(box.style.left)).toBeCloseTo(50);
  });

  test('a moment sticker is never written to, even where its pose differs from the drawn one', async () => {
    const { left, seek } = await render(momentStickerTrack({ ...start, x: 0.6 }, 0, 3000));

    seek(1);

    expect(left()).toBeCloseTo(20);
  });
});

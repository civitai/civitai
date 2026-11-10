import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as RevealStore from '~/store/sticker-reveal.store';
import { encodeStickerTrack, momentStickerTrack } from '~/shared/utils/sticker-track';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const IMAGE_ID = 74;
const pose = { x: 0.5, y: 0.5, scale: 0.25, rotation: 0 };

const { flags, tracksQuery, historyStep } = vi.hoisted(() => ({
  flags: { stickerVideoTracks: true },
  tracksQuery: vi.fn(),
  historyStep: { value: null as number | null },
}));

vi.mock('~/store/sticker-history.store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useStickerHistoryStep: () => historyStep.value,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => flags,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trpc: (await import('../../../test/trpcProxyStub')).makeTrpcProxy({
    'placement.getStickerTracks': { useQuery: tracksQuery },
  }),
}));
vi.mock('~/store/sticker-reveal.store', async (importOriginal) => ({
  ...(await importOriginal<typeof RevealStore>()),
  useStickerRevealStore: (select: (state: { revealed: boolean; forced: boolean }) => unknown) =>
    select({ revealed: true, forced: false }),
}));
vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useStickerPlacements: () => ({
    byImage: new Map([[IMAGE_ID, [{ id: 1, imageId: IMAGE_ID, isPending: false, data: pose }]]]),
  }),
}));
vi.mock('~/components/Sticker/treatments/useStickerTreatment', () => ({
  useStickerTreatment: () => 'none',
}));
vi.mock('~/components/Sticker/DraftStickerLayer', () => ({ DraftStickerLayer: () => null }));
vi.mock('~/components/Sticker/StickerPlacementOverlay', () => ({
  StickerPlacementOverlay: ({
    hiddenIds,
    bindPose,
  }: {
    hiddenIds?: ReadonlySet<number>;
    bindPose?: (id: number) => (node: HTMLElement | null) => void;
  }) => (
    <div data-testid="hidden" ref={bindPose?.(1)}>
      {[...(hiddenIds ?? [])].join(',') || 'none'}
    </div>
  ),
}));

const { ImageStickerOverlay } = await import('~/components/Sticker/ImageStickerOverlay');

const renderOnVideo = async (startTime: number) => {
  renderWithProviders(
    <div style={{ position: 'relative', width: 400, height: 400 }}>
      <video data-testid="media" style={{ width: 200, height: 200 }} />
      <ImageStickerOverlay imageId={IMAGE_ID} />
    </div>
  );
  await expect.element(page.getByTestId('media')).toBeInTheDocument();
  const video = page.getByTestId('media').element() as HTMLVideoElement;
  let time = startTime;
  Object.defineProperty(video, 'currentTime', { get: () => time });
  return {
    seek: (seconds: number) => {
      time = seconds;
      video.dispatchEvent(new Event('seeked'));
    },
  };
};

const hidden = () => page.getByTestId('hidden');

describe('a moment sticker follows the video', () => {
  beforeEach(() => {
    flags.stickerVideoTracks = true;
    historyStep.value = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLMediaElement.prototype as { currentTime?: number }).currentTime;
  });

  test('hidden before its moment, shown during, hidden after, and again on a seek back', async () => {
    tracksQuery.mockReturnValue({
      data: [{ id: 1, track: momentStickerTrack(pose, 12000, 1000) }],
    });
    const { seek } = await renderOnVideo(0);

    await expect.element(hidden()).toHaveTextContent('1');
    seek(12.5);
    await expect.element(hidden()).toHaveTextContent('none');
    seek(13.5);
    await expect.element(hidden()).toHaveTextContent('1');
    seek(12.2);
    await expect.element(hidden()).toHaveTextContent('none');
  });

  test('playback alone moves it across its window, and unmounting stops the frame callback', async () => {
    tracksQuery.mockReturnValue({
      data: [{ id: 1, track: momentStickerTrack(pose, 12000, 1000) }],
    });
    let onFrame: (() => void) | undefined;
    const cancel = vi.spyOn(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
    vi.spyOn(HTMLVideoElement.prototype, 'requestVideoFrameCallback').mockImplementation(
      (callback) => {
        onFrame = callback as unknown as () => void;
        return 7;
      }
    );
    let time = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: () => time,
    });

    const { unmount } = await renderWithProviders(
      <div style={{ position: 'relative', width: 400, height: 400 }}>
        <video style={{ width: 200, height: 200 }} />
        <ImageStickerOverlay imageId={IMAGE_ID} />
      </div>
    );
    await expect.element(hidden()).toHaveTextContent('1');

    time = 12.5;
    onFrame?.();
    await expect.element(hidden()).toHaveTextContent('none');

    await unmount();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  test('a recorded path moves the sticker it draws', async () => {
    tracksQuery.mockReturnValue({
      data: [
        {
          id: 1,
          track: encodeStickerTrack([pose, { ...pose, x: 0.9 }]),
        },
      ],
    });
    const { seek } = await renderOnVideo(0);
    await expect.element(hidden()).toBeInTheDocument();

    seek(0.1);

    // Drawn, not inline: playback animates over the element's own style.
    expect(getComputedStyle(hidden().element()).left).toBe('90%');
  });

  test('only the sticker outside its window is hidden', async () => {
    tracksQuery.mockReturnValue({
      data: [
        { id: 1, track: momentStickerTrack(pose, 0, 1000) },
        { id: 2, track: momentStickerTrack(pose, 12000, 1000) },
      ],
    });
    await renderOnVideo(0);

    await expect.element(hidden()).toHaveTextContent(/^2$/);
  });

  test('with the flag off it never asks for tracks and hides nothing', async () => {
    flags.stickerVideoTracks = false;
    tracksQuery.mockClear();
    tracksQuery.mockReturnValue({
      data: [{ id: 1, track: momentStickerTrack(pose, 12000, 1000) }],
    });
    await renderOnVideo(0);
    // The box arriving means the media has been bound, so `video` would be set by now.
    await expect.element(hidden()).toHaveTextContent('none');

    for (const [, options] of tracksQuery.mock.calls) expect(options.enabled).toBe(false);
  });

  test('a replay of the history shows every sticker it steps through', async () => {
    historyStep.value = 0;
    tracksQuery.mockReturnValue({
      data: [{ id: 1, track: momentStickerTrack(pose, 12000, 1000) }],
    });
    await renderOnVideo(0);

    await expect.element(hidden()).toHaveTextContent('none');
    expect(tracksQuery.mock.lastCall?.[1].enabled).toBe(true);
  });
});

import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as RevealStore from '~/store/sticker-reveal.store';
import { momentStickerTrack } from '~/shared/utils/sticker-track';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const IMAGE_ID = 74;
const pose = { x: 0.5, y: 0.5, scale: 0.25, rotation: 0 };

const { flags, tracksQuery } = vi.hoisted(() => ({
  flags: { stickerVideoTracks: true },
  tracksQuery: vi.fn(),
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
// What is asserted is which stickers the layer is told to hide.
vi.mock('~/components/Sticker/StickerPlacementOverlay', () => ({
  StickerPlacementOverlay: ({ hiddenIds }: { hiddenIds?: ReadonlySet<number> }) => (
    <div data-testid="hidden">{[...(hiddenIds ?? [])].join(',') || 'none'}</div>
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

  test('a sticker with no track is never hidden', async () => {
    tracksQuery.mockReturnValue({ data: [] });
    const { seek } = await renderOnVideo(0);

    seek(5);
    await expect.element(hidden()).toHaveTextContent('none');
  });

  test('with the flag off it asks for no tracks', async () => {
    flags.stickerVideoTracks = false;
    tracksQuery.mockReturnValue({ data: undefined });
    await renderOnVideo(0);

    await expect.element(hidden()).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(tracksQuery).toHaveBeenLastCalledWith(
        { imageId: IMAGE_ID },
        expect.objectContaining({ enabled: false })
      )
    );
    flags.stickerVideoTracks = true;
  });
});

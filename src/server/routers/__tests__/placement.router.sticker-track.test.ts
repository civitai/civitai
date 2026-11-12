import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StickerPlacementService from '~/server/services/sticker-placement.service';
import { encodeStickerTrack } from '~/shared/utils/sticker-track';

const { createStickerPlacement, getStickerPlacementTracks } = vi.hoisted(() => ({
  createStickerPlacement: vi.fn(async () => ({ id: 1 })),
  getStickerPlacementTracks: vi.fn(async () => [{ id: 1, track: {} }]),
}));

vi.mock('~/server/services/sticker-placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerPlacementService>()),
  createStickerPlacement,
  getStickerPlacementTracks,
}));

import {
  STICKER_DATA,
  placementCaller,
} from '~/server/routers/__tests__/placement.router.test-utils';

const track = encodeStickerTrack([
  { x: 0.2, y: 0.5, scale: 0.1, rotation: 0 },
  { x: 0.3, y: 0.5, scale: 0.1, rotation: 0 },
]);

beforeEach(() => vi.clearAllMocks());

describe('placement router — moving stickers sit behind their own flag', () => {
  it('refuses a track while the flag is off', async () => {
    await expect(
      placementCaller({ features: { stickerVideoTracks: false } }).createSticker({
        imageId: 99,
        data: STICKER_DATA,
        track,
      })
    ).rejects.toThrow(/moving stickers are not available/);
    expect(createStickerPlacement).not.toHaveBeenCalled();
  });

  it('still places a still sticker while the flag is off', async () => {
    await placementCaller({ features: { stickerVideoTracks: false } }).createSticker({
      imageId: 99,
      data: STICKER_DATA,
    });
    expect(createStickerPlacement).toHaveBeenCalledTimes(1);
  });

  it('passes the track through when the flag is on', async () => {
    await placementCaller({ features: { stickerVideoTracks: true } }).createSticker({
      imageId: 99,
      data: STICKER_DATA,
      track,
    });
    expect(createStickerPlacement).toHaveBeenCalledWith(expect.objectContaining({ track }));
  });

  it('reads no tracks while the flag is off', async () => {
    const tracks = await placementCaller({
      features: { stickerVideoTracks: false },
    }).getStickerTracks({ imageId: 99 });

    expect(tracks).toEqual([]);
    expect(getStickerPlacementTracks).not.toHaveBeenCalled();
  });

  it('reads the tracks for that image when the flag is on', async () => {
    const tracks = await placementCaller({
      features: { stickerVideoTracks: true },
    }).getStickerTracks({ imageId: 99 });

    expect(tracks).toHaveLength(1);
    expect(getStickerPlacementTracks).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 99 })
    );
  });

  it('reads them for the signed-in viewer, whose pending stickers it includes', async () => {
    await placementCaller({
      features: { stickerVideoTracks: true },
      user: { id: 4242 },
    }).getStickerTracks({ imageId: 99 });

    expect(getStickerPlacementTracks).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 99, viewerId: 4242 })
    );
  });
});

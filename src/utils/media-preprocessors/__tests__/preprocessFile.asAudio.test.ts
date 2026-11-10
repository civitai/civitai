import { describe, expect, it, vi } from 'vitest';

const { preprocessAudio, preprocessImage } = vi.hoisted(() => ({
  preprocessAudio: vi.fn(),
  preprocessImage: vi.fn(async () => ({ objectUrl: 'blob:img', metadata: {}, meta: undefined })),
}));
vi.mock('~/utils/media-preprocessors/audio.preprocessor', () => ({ preprocessAudio }));
vi.mock('~/utils/media-preprocessors/image.preprocessor', () => ({ preprocessImage }));
vi.mock('~/utils/media-preprocessors/video.preprocessor', () => ({ preprocessVideo: vi.fn() }));

import { preprocessFile } from '~/utils/media-preprocessors';

describe('preprocessFile with asAudio', () => {
  it('keeps an image an image: only audio and video containers are probed as a song', async () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    expect(await preprocessFile(png, { asAudio: true })).toMatchObject({ type: 'image' });
    expect(preprocessAudio).not.toHaveBeenCalled();
  });
});

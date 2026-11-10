import { describe, expect, it, vi } from 'vitest';
import { checkIntentMedia } from '~/components/Post/Intent/check-intent-media';

const deps = (blob: Blob, video = { duration: 10, width: 1080, height: 1920 }) => ({
  fetchBlob: vi.fn().mockResolvedValue(blob),
  loadImage: vi.fn().mockResolvedValue({}),
  readVideo: vi.fn().mockResolvedValue(video),
  createObjectUrl: vi.fn().mockReturnValue('blob:1'),
  revokeObjectUrl: vi.fn(),
});

const mp4 = new Blob([new Uint8Array(10)], { type: 'video/mp4' });

describe('checkIntentMedia', () => {
  it('accepts a video within the site limits', async () => {
    await expect(checkIntentMedia('https://x.test/a.mp4', deps(mp4))).resolves.toEqual({
      url: 'https://x.test/a.mp4',
      type: 'video',
      bytes: 10,
    });
  });

  it('fails a video that is too long instead of reporting success', async () => {
    const d = deps(mp4, { duration: 300, width: 1080, height: 1920 });
    await expect(checkIntentMedia('https://x.test/a.mp4', d)).rejects.toThrow(/245 seconds/);
    expect(d.revokeObjectUrl).toHaveBeenCalledWith('blob:1');
  });

  it('fails a video it cannot read', async () => {
    const d = deps(mp4);
    d.readVideo.mockRejectedValue(new Error('decode'));
    await expect(checkIntentMedia('https://x.test/a.mp4', d)).rejects.toThrow(/Could not read/);
  });

  it('refuses a type the site does not accept', async () => {
    const html = new Blob(['<html>'], { type: 'text/html' });
    await expect(checkIntentMedia('https://x.test/a', deps(html))).rejects.toThrow(/Unsupported/);
  });
});

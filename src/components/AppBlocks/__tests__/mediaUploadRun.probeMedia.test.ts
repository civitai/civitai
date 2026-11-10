// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_UPLOAD_UNREADABLE_ERROR } from '../mediaUploadLogic';
import { MediaUploadError, probeMedia } from '../mediaUploadRun';
import { mockMediaElements } from '~/utils/media-preprocessors/__tests__/fake-media-element';

describe('probeMedia', () => {
  let revoke: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe');
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports an audio blob duration in milliseconds and frees its URL', async () => {
    mockMediaElements('load', { duration: 2.5 });
    await expect(probeMedia('audio', new Blob(['x']))).resolves.toEqual({ durationMs: 2500 });
    expect(revoke).toHaveBeenCalledWith('blob:probe');
  });

  it('resolves an Infinity duration (MediaRecorder WebM) by seeking to the end', async () => {
    mockMediaElements('load', { duration: Infinity, resolvedDuration: 4 });
    await expect(probeMedia('audio', new Blob(['x']))).resolves.toEqual({ durationMs: 4000 });
  });

  it('reports a video blob dimensions', async () => {
    mockMediaElements('load', { duration: 1 });
    await expect(probeMedia('video', new Blob(['x']))).resolves.toEqual({
      width: 16,
      height: 16,
      durationMs: 1000,
    });
  });

  it('refuses a file the browser cannot decode with the block-facing copy', async () => {
    mockMediaElements('error');
    const error = await probeMedia('audio', new Blob(['x'])).catch((e) => e);
    expect(error).toBeInstanceOf(MediaUploadError);
    expect(error.message).toBe(MEDIA_UPLOAD_UNREADABLE_ERROR.audio);
    expect(revoke).toHaveBeenCalledWith('blob:probe');
  });
});

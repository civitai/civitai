// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR,
  MEDIA_UPLOAD_UNREADABLE_ERROR,
} from '../mediaUploadLogic';
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
    expect(revoke).toHaveBeenCalledWith('blob:probe');
  });

  it('reports a video blob dimensions', async () => {
    const created = mockMediaElements('load', { duration: 1 });
    await expect(probeMedia('video', new Blob(['x']))).resolves.toEqual({
      width: 16,
      height: 16,
      durationMs: 1000,
    });
    expect(revoke).toHaveBeenCalledWith('blob:probe');
    expect(created[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(created[0].load).toHaveBeenCalled();
  });

  it('refuses a video with no video track', async () => {
    mockMediaElements('load', { duration: 1, videoWidth: 0 });
    const error = await probeMedia('video', new Blob(['x'])).catch((e) => e);
    expect(error).toBeInstanceOf(MediaUploadError);
    expect(error.message).toBe(MEDIA_UPLOAD_NO_VIDEO_TRACK_ERROR);
    expect(revoke).toHaveBeenCalledWith('blob:probe');
  });

  it('refuses a file the browser cannot decode with the block-facing copy', async () => {
    const created = mockMediaElements('error');
    const error = await probeMedia('audio', new Blob(['x'])).catch((e) => e);
    expect(error).toBeInstanceOf(MediaUploadError);
    expect(error.message).toBe(MEDIA_UPLOAD_UNREADABLE_ERROR.audio);
    expect(created[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(created[0].load).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:probe');
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preprocessFile } from '~/utils/media-preprocessors';
import { preprocessAudio } from '~/utils/media-preprocessors/audio.preprocessor';
import { mockMediaElements } from './fake-media-element';

const file = new File(['x'], 'song.mp3', { type: 'audio/mpeg' });

describe('preprocessAudio', () => {
  let revoke: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the duration and file size as audio metadata', async () => {
    mockMediaElements('load');
    const result = await preprocessAudio(file);
    expect(result.objectUrl).toBe('blob:fake');
    expect(result.metadata).toEqual({ size: 1, duration: 12.346 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('resolves a duration-less file by seeking to the end', async () => {
    mockMediaElements('load', { duration: Infinity, resolvedDuration: 30 });
    expect((await preprocessAudio(file)).metadata.duration).toBe(30);
  });

  it('rejects, and frees the blob URL, when the duration cannot be resolved', async () => {
    vi.useFakeTimers();
    mockMediaElements('load', { duration: Infinity });
    const pending = expect(preprocessAudio(file)).rejects.toThrow(/audio/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });

  it('rejects, and frees the blob URL, when the file cannot be decoded', async () => {
    mockMediaElements('error');
    await expect(preprocessAudio(file)).rejects.toThrow(/audio/i);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });

  it('rejects, and frees the blob URL, when metadata never loads', async () => {
    vi.useFakeTimers();
    mockMediaElements('never');
    const pending = expect(preprocessAudio(file)).rejects.toThrow(/audio/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});

describe('preprocessFile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses audio before probing it unless the caller says it is a song', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const created = mockMediaElements('load');
    await expect(preprocessFile(file)).rejects.toThrow(/audio uploads are not supported/i);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('routes an .mp3 song to the audio preprocessor', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    mockMediaElements('load');
    const result = await preprocessFile(file, { asAudio: true });
    expect(result).toMatchObject({ type: 'audio', name: 'song.mp3', mimeType: 'audio/mpeg' });
  });

  it('probes a cover-muxed mp4 song as audio, not as a video', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    mockMediaElements('load');
    const mp4 = new File(['x'], 'song.mp4', { type: 'video/mp4' });
    expect(await preprocessFile(mp4, { asAudio: true })).toMatchObject({
      type: 'audio',
      mimeType: 'video/mp4',
      metadata: { duration: 12.346 },
    });
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preprocessAudio } from '~/utils/media-preprocessors/audio.preprocessor';

type FakeAudio = {
  duration: number;
  onloadedmetadata: null | (() => void);
  onerror: null | (() => void);
  src: string;
};

/** An `<audio>` stand-in: happy-dom never decodes media, so load events are fired by hand. */
function mockAudio(behavior: 'load' | 'error' | 'never', duration = 12.3456) {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'audio') return create(tag);
    const audio: FakeAudio = {
      duration,
      onloadedmetadata: null,
      onerror: null,
      set src(_: string) {
        if (behavior === 'load') queueMicrotask(() => audio.onloadedmetadata?.());
        if (behavior === 'error') queueMicrotask(() => audio.onerror?.());
      },
    } as FakeAudio;
    return audio;
  }) as typeof document.createElement);
}

const file = new File(['x'], 'song.mp3', { type: 'audio/mpeg' });

describe('preprocessAudio', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the duration and file size as audio metadata', async () => {
    mockAudio('load');
    const result = await preprocessAudio(file);
    expect(result.objectUrl).toBe('blob:fake');
    expect(result.metadata).toEqual({ size: 1, duration: 12.346 });
  });

  it('rejects when the file cannot be decoded', async () => {
    mockAudio('error');
    await expect(preprocessAudio(file)).rejects.toThrow(/audio/i);
  });

  it('rejects when metadata never loads', async () => {
    vi.useFakeTimers();
    mockAudio('never');
    const pending = expect(preprocessAudio(file)).rejects.toThrow(/audio/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });
});

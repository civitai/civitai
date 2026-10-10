import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VideoEnhancement from '~/server/services/orchestrator/videoEnhancement';

const { getVideoMetadataMock } = vi.hoisted(() => ({ getVideoMetadataMock: vi.fn() }));

vi.mock('~/server/services/orchestrator/videoEnhancement', async (importOriginal) => ({
  ...(await importOriginal<typeof VideoEnhancement>()),
  getVideoMetadata: getVideoMetadataMock,
}));

import { parseTimeSpanSeconds, probeVideoDimensions } from '~/server/services/video-dimensions';

const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('probeVideoDimensions', () => {
  it('returns width, height and the duration in seconds', async () => {
    getVideoMetadataMock.mockResolvedValue({
      width: 640,
      height: 1152,
      fps: 24,
      duration: '00:00:12.5000000',
    });

    expect(await probeVideoDimensions(KEY)).toEqual({ width: 640, height: 1152, duration: 12.5 });
    expect(getVideoMetadataMock).toHaveBeenCalledTimes(1);
    expect(getVideoMetadataMock.mock.calls[0][0].videoUrl).toContain(KEY);
  });

  it('never hands a disallowed url to the orchestrator', async () => {
    expect(await probeVideoDimensions('http://169.254.169.254/latest')).toBeNull();
    expect(getVideoMetadataMock).not.toHaveBeenCalled();
  });

  it('treats zero dimensions as no answer', async () => {
    getVideoMetadataMock.mockResolvedValue({ width: 0, height: 0, fps: 0, duration: '' });

    expect(await probeVideoDimensions(KEY)).toBeNull();
  });

  it('returns null when the probe fails', async () => {
    getVideoMetadataMock.mockRejectedValue(new Error('Unable to analyze video file.'));

    expect(await probeVideoDimensions(KEY)).toBeNull();
  });

  it('gives up on a probe that never answers', async () => {
    vi.useFakeTimers();
    getVideoMetadataMock.mockReturnValue(new Promise(() => undefined));

    const result = probeVideoDimensions(KEY);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toBeNull();
  });
});

describe('parseTimeSpanSeconds', () => {
  it.each([
    ['00:00:12.5000000', 12.5],
    ['00:01:05', 65],
    ['1.02:00:00', 93600],
  ])('%s → %s', (value, seconds) => {
    expect(parseTimeSpanSeconds(value)).toBe(seconds);
  });

  it.each([[''], ['12.5'], [12.5], [null]])('%s → undefined', (value) => {
    expect(parseTimeSpanSeconds(value)).toBeUndefined();
  });
});

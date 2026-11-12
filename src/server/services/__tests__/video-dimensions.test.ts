import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VideoEnhancement from '~/server/services/orchestrator/videoEnhancement';

const { getVideoMetadataMock } = vi.hoisted(() => ({ getVideoMetadataMock: vi.fn() }));

vi.mock('~/server/services/orchestrator/videoEnhancement', async (importOriginal) => ({
  ...(await importOriginal<typeof VideoEnhancement>()),
  getVideoMetadata: getVideoMetadataMock,
}));

import { KNOWN_ORCHESTRATOR_HOSTS } from '~/server/services/orchestrator/trusted-blob-url';
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

  // The probe runs on the system orchestrator token, so an absolute url must be Civitai-hosted
  // media: the image CDN or the orchestrator. Anything else is skipped, not probed.
  it.each([
    ['a third-party https host', 'https://example.com/video.mp4'],
    ['an object-store bucket host', 'https://some-bucket.s3.wasabisys.com/video.mp4'],
    ['a path-style object-store url', 'https://s3.us-west-1.wasabisys.com/some-bucket/video.mp4'],
    ['a Civitai subdomain on a non-default port', `https://files.civitai.com:8443/${KEY}.mp4`],
    ['the image CDN on a non-default port', `https://image.civitai.com:8443/${KEY}/video.mp4`],
    ['a Civitai host that is not the image CDN', `https://civitai.com/${KEY}.mp4`],
    ['plain http to the image CDN', `http://image.civitai.com/${KEY}/video.mp4`],
    ['userinfo', `https://user:pass@image.civitai.com/${KEY}/video.mp4`],
    ['plain http to the orchestrator', 'http://orchestration.civitai.com/v2/consumer/blobs/A.mp4'],
  ])('skips %s without running the probe', async (_label, url) => {
    getVideoMetadataMock.mockResolvedValue({ width: 640, height: 360, fps: 24, duration: '' });

    expect(await probeVideoDimensions(url)).toBeNull();
    expect(getVideoMetadataMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the image CDN', `https://image.civitai.com/${KEY}/original=true/video.mp4`],
    ...KNOWN_ORCHESTRATOR_HOSTS.map((host) => [
      `the orchestrator host ${host}`,
      `https://${host}/v2/consumer/blobs/ABC123.mp4`,
    ]),
  ])('probes a video on %s', async (_label, url) => {
    getVideoMetadataMock.mockResolvedValue({ width: 640, height: 360, fps: 24, duration: '' });

    expect(await probeVideoDimensions(url)).toEqual({ width: 640, height: 360 });
    expect(getVideoMetadataMock).toHaveBeenCalledWith({ videoUrl: url });
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

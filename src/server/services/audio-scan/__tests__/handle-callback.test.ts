import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ process: vi.fn(), apply: vi.fn() }));
vi.mock('~/server/services/video-audio-scan.service', () => ({
  processAudioScanCallback: mocks.process,
}));
vi.mock('~/server/services/audio-scan/apply-song-scan', () => ({
  applySongScanResult: mocks.apply,
}));

import { handleAudioScanCallback } from '~/server/services/audio-scan/handle-callback';

beforeEach(() => vi.clearAllMocks());

describe('handleAudioScanCallback', () => {
  it("decides a song's ingestion from its stored scan, and leaves the song out of the response", async () => {
    const song = { imageId: 7, workflowId: 'wf', steps: [], parsed: { ok: false, error: 'x' } };
    mocks.process.mockResolvedValue({ stored: true, reason: 'succeeded', song });

    const result = await handleAudioScanCallback('wf');

    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith(song);
    expect(result).toEqual({ stored: true, reason: 'succeeded' });
  });

  it('decides nothing for a video: its scan is stored and that is all', async () => {
    mocks.process.mockResolvedValue({ stored: true, reason: 'succeeded' });

    await handleAudioScanCallback('wf');

    expect(mocks.apply).not.toHaveBeenCalled();
  });
});

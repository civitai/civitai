import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mode: vi.fn(), scan: vi.fn() }));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTextScanMode: mocks.mode,
}));
vi.mock('~/server/services/text-scan/submit', () => ({ scanEntity: mocks.scan }));

import { sendTrackLyricsScan } from '~/server/services/audio-scan/track-lyrics';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode.mockResolvedValue('active');
  mocks.scan.mockResolvedValue({ status: 'submitted', workflowId: 'wf-1' });
});

describe("sending a song's lyrics", () => {
  it('sends them to the active text scan', async () => {
    await expect(sendTrackLyricsScan(7)).resolves.toBeUndefined();

    expect(mocks.scan).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'TrackLyrics', entityId: 7 })
    );
  });

  // A send that returned quietly would leave the song re-driven forever with no retry counted.
  it.each(['off', 'shadow'])(
    'throws while the text scan is %s, with no fallback scan',
    async (mode) => {
      mocks.mode.mockResolvedValue(mode);

      await expect(sendTrackLyricsScan(7)).rejects.toThrow('lyrics scan not sent');
      expect(mocks.scan).not.toHaveBeenCalled();
    }
  );

  it.each(['off', 'too-short', 'missing-prompt'])(
    'throws when the active scan skips them as %s',
    async (reason) => {
      mocks.scan.mockResolvedValue({ status: 'skipped', reason });

      await expect(sendTrackLyricsScan(7)).rejects.toThrow('lyrics scan not sent');
    }
  );
});

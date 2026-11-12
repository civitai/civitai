import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mode: vi.fn(), scan: vi.fn() }));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTextScanMode: mocks.mode,
}));
vi.mock('~/server/services/text-scan/submit', () => ({ scanEntity: mocks.scan }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { SONG_LYRICS_MAX_LENGTH } from '~/server/common/constants';
import {
  saveGeneratedTrackLyrics,
  sendTrackLyricsScan,
} from '~/server/services/audio-scan/track-lyrics';

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

describe('saving generated lyrics', () => {
  const saved = () => dbMock.dbWrite.trackLyrics.upsert.mock.calls[0][0].create;

  it('stores lyrics under the cap as they came', async () => {
    await saveGeneratedTrackLyrics({ imageId: 7, text: '[Verse]\nrain' });

    expect(saved()).toMatchObject({
      text: '[Verse]\nrain',
      lines: [
        { t: null, text: '[Verse]' },
        { t: null, text: 'rain' },
      ],
    });
  });

  it('cuts lyrics over the cap at the last whole line', async () => {
    const line = 'x'.repeat(99);
    const text = Array.from({ length: 150 }, () => line).join('\n');

    await saveGeneratedTrackLyrics({ imageId: 7, text });

    const { text: stored, lines } = saved();
    expect(stored.length).toBeLessThanOrEqual(SONG_LYRICS_MAX_LENGTH);
    expect(lines).toHaveLength(100);
    expect(lines.every((l: { text: string }) => l.text === line)).toBe(true);
  });
});

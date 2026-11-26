import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ align: vi.fn() }));
// The alignment recipe crosses to the orchestrator.
vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invokeLyricsAlignmentStepTemplate: mocks.align,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { alignTrackLyrics } from '~/server/services/audio-scan/lyrics-alignment';

const TEXT = '[Verse]\nRain on the window\n\nSun on the floor';
const STORED = [
  { t: null, text: '[Verse]' },
  { t: null, text: 'Rain on the window' },
  { t: null, text: 'Sun on the floor' },
];
const ALIGNED = [
  { index: 0, text: '[Verse]', status: 'ignored', startTime: null, words: [] },
  { index: 1, text: 'Rain on the window', status: 'aligned', startTime: 12.3456, words: [] },
  { index: 2, text: '', status: 'ignored', startTime: null, words: [] },
  { index: 3, text: 'Sun on the floor', status: 'lowConfidence', startTime: 18.5, words: [] },
];

const answer = (lines: unknown[] | undefined, status = 200) =>
  mocks.align.mockResolvedValue({
    data: lines ? { text: TEXT, lines } : undefined,
    response: { status },
  });

const align = () => alignTrackLyrics({ imageId: 7, url: 'song-key' });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValue({ text: TEXT, lines: STORED } as never);
  dbMock.dbWrite.trackLyrics.updateMany.mockResolvedValue({ count: 1 } as never);
  answer(ALIGNED);
});

describe("aligning a song's lyrics", () => {
  it('sends the stored text with the song’s original audio url', async () => {
    await align();

    const { body } = mocks.align.mock.calls[0][0];
    expect(body.lyrics).toBe(TEXT);
    expect(body.mediaUrl).toContain('song-key/original=true/');
  });

  it('stores each sung line’s start in ms, leaves labels untimed, and marks them aligned', async () => {
    await expect(align()).resolves.toBe(true);

    expect(dbMock.dbWrite.trackLyrics.updateMany).toHaveBeenCalledWith({
      where: { imageId: 7, text: TEXT },
      data: {
        lines: [
          { t: null, text: '[Verse]' },
          { t: 12346, text: 'Rain on the window' },
          { t: 18500, text: 'Sun on the floor' },
        ],
        source: 'aligned',
      },
    });
  });

  it('leaves the lyrics untimed when the song cannot be aligned (204)', async () => {
    answer(undefined, 204);

    await expect(align()).resolves.toBe(false);
    expect(dbMock.dbWrite.trackLyrics.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the aligned lines are not the stored lines', async () => {
    answer([...ALIGNED.slice(0, 3), { ...ALIGNED[3], text: 'Moon on the floor' }]);

    await expect(align()).resolves.toBe(false);
    expect(dbMock.dbWrite.trackLyrics.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when no line came back timed', async () => {
    answer(ALIGNED.map((line) => ({ ...line, status: 'ignored', startTime: null })));

    await expect(align()).resolves.toBe(false);
    expect(dbMock.dbWrite.trackLyrics.updateMany).not.toHaveBeenCalled();
  });

  it('reports no timing when the lyrics were replaced while it ran', async () => {
    dbMock.dbWrite.trackLyrics.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(align()).resolves.toBe(false);
  });

  it('sends nothing for a song without stored lyrics, or a url the scan guard refuses', async () => {
    dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValueOnce(null);
    await expect(align()).resolves.toBe(false);

    await expect(
      alignTrackLyrics({ imageId: 7, url: 'http://169.254.169.254/latest' })
    ).resolves.toBe(false);

    expect(mocks.align).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ route: vi.fn(), xguard: vi.fn() }));
// The text-scan/XGuard choice by mode is the route's own rule, tested with it.
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitTextModerationOrScan: mocks.route,
}));
// The XGuard request crosses to the orchestrator.
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: mocks.xguard,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { SONG_LYRICS_MAX_LENGTH } from '~/server/common/constants';
import {
  saveGeneratedTrackLyrics,
  sendTrackLyricsScan,
} from '~/server/services/audio-scan/track-lyrics';
import { TEXT_SCAN_ENTITY_GONE } from '~/server/services/text-scan/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockResolvedValue({ id: 'wf-1' });
  mocks.xguard.mockResolvedValue({ id: 'xg-1' });
  dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValue({ text: '[Verse]\nrain' } as never);
});

/** The XGuard leg the route runs while the text scan is off or in shadow for the lyrics. */
const xguardLeg = () => mocks.route.mock.calls[0][0].xguard();

describe("sending a song's lyrics", () => {
  it('sends them as TrackLyrics, to the text scan or XGuard by its mode', async () => {
    await expect(sendTrackLyricsScan(7)).resolves.toBeUndefined();

    expect(mocks.route).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'TrackLyrics', entityId: 7 })
    );
  });

  it('sends their stored text to XGuard when the text scan is not active', async () => {
    await sendTrackLyricsScan(7);

    await expect(xguardLeg()).resolves.toEqual({ id: 'xg-1' });
    expect(mocks.xguard).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'text',
        entityType: 'TrackLyrics',
        entityId: 7,
        content: '[Verse]\nrain',
      })
    );
  });

  // A song whose title was cleared and that has no lyrics has no text left: its old title verdict
  // must stop raising the song (docs/features/music.md "A song's rating").
  it('drops the stored verdict of a song left with no text to scan', async () => {
    await sendTrackLyricsScan(7).catch(() => undefined);
    await mocks.route.mock.calls[0][0].onActiveSkip('missing');

    expect(dbMock.dbWrite.entityModeration.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'TrackLyrics', entityId: 7 },
    });
  });

  it('reports lyrics deleted before the XGuard send as gone, sending nothing', async () => {
    dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValue(null);
    await sendTrackLyricsScan(7);

    await expect(xguardLeg()).resolves.toBe(TEXT_SCAN_ENTITY_GONE);
    expect(mocks.xguard).not.toHaveBeenCalled();
  });

  // A send that returned quietly would leave the song re-driven forever with no retry counted.
  it.each([
    ['failed to submit', null],
    ['was skipped', TEXT_SCAN_ENTITY_GONE],
  ])('throws when the send %s', async (_, workflow) => {
    mocks.route.mockResolvedValue(workflow);

    await expect(sendTrackLyricsScan(7)).rejects.toThrow('lyrics scan not sent');
  });
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

  it('cuts a single line longer than the cap at the cap', async () => {
    const text = 'y'.repeat(SONG_LYRICS_MAX_LENGTH + 50);

    await saveGeneratedTrackLyrics({ imageId: 7, text });

    const { text: stored, lines } = saved();
    expect(stored).toBe('y'.repeat(SONG_LYRICS_MAX_LENGTH));
    expect(lines).toEqual([{ t: null, text: stored }]);
  });
});

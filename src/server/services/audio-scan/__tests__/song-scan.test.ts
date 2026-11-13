import { describe, expect, it } from 'vitest';
import { songVerdict } from '~/server/services/audio-scan/song-scan';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';

describe('songVerdict', () => {
  const scanned = (flagged: boolean): AudioScanParse => ({
    ok: true,
    flagged,
    hasAudio: true,
    result: {} as never,
  });
  const noAudio: AudioScanParse = { ok: true, flagged: null, hasAudio: false, result: {} as never };

  it('blocks a song the scan flagged', () => {
    expect(songVerdict(scanned(true), true)).toEqual({ action: 'block' });
  });

  it('clears a song the scan did not flag', () => {
    expect(songVerdict(scanned(false), true)).toEqual({ action: 'clean' });
  });

  it('clears an instrumental: nothing was sung and no lyrics were stored, so there is nothing to flag', () => {
    expect(songVerdict(noAudio, false)).toEqual({ action: 'clean' });
  });

  it('does not clear a song whose stored lyrics the scan reports it could not read', () => {
    expect(songVerdict(noAudio, true)).toMatchObject({ action: 'retry' });
  });

  it('retries a failed scan, keeping why', () => {
    expect(songVerdict({ ok: false, error: 'workflow failed' }, false)).toEqual({
      action: 'retry',
      reason: 'workflow failed',
    });
  });
});

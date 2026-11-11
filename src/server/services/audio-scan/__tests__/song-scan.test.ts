import { describe, expect, it } from 'vitest';
import {
  buildSongScanSteps,
  readTranscriptionWords,
  songVerdict,
} from '~/server/services/audio-scan/song-scan';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';

const metadata = { imageId: 7, scan: 'song' };
const base = { mediaUrl: 'https://cdn.test/song.mp3', metadata, priority: 'normal' as const };
const unsynced = [
  { t: null, text: '[Verse]' },
  { t: null, text: 'la la la' },
];

describe('buildSongScanSteps', () => {
  it('takes the verdict from audioModeration and runs the transcription beside it, with no reference between them', () => {
    const [transcribe, moderate] = buildSongScanSteps({ ...base, lyrics: unsynced }) as any[];

    expect(transcribe).toMatchObject({
      $type: 'transcription',
      name: 'transcribe',
      input: { mediaUrl: base.mediaUrl, returnTimeStamps: true },
    });
    expect(moderate).toMatchObject({
      $type: 'audioModeration',
      input: { mediaUrl: base.mediaUrl, transcriber: 'auto' },
    });
    expect(JSON.stringify(moderate)).not.toContain('$ref');
  });

  it('builds the same steps for a song with no stored lyrics', () => {
    const steps = buildSongScanSteps({ ...base, lyrics: undefined }) as any[];

    expect(steps.map((s) => s.$type)).toEqual(['transcription', 'audioModeration']);
  });

  it('transcribes even when the client sent a time for every line, so lyrics never stand in for the audio check', () => {
    const steps = buildSongScanSteps({
      ...base,
      lyrics: [
        { t: 1, text: 'timed' },
        { t: 5, text: 'also timed' },
      ],
    }) as any[];

    expect(steps.map((s) => s.$type)).toEqual(['transcription', 'audioModeration']);
  });
});

describe('readTranscriptionWords', () => {
  const step = (output: unknown) => ({ $type: 'transcription', name: 'transcribe', output });

  it('reads the word timestamps of the transcription step', () => {
    const words = [{ text: ' hi', startTime: 1, endTime: 1.2 }];

    expect(readTranscriptionWords([step({ text: 'hi', timeStamps: words })])).toEqual(words);
  });

  it.each([
    ['no transcription step', []],
    ['an output without timestamps', [step({ text: 'hi' })]],
    ['malformed timestamps', [step({ timeStamps: [{ text: 'x' }] })]],
    ['empty timestamps', [step({ text: 'hi', timeStamps: [] })]],
    [
      'a transcription that failed',
      [{ ...step({ timeStamps: [{ text: 'x', startTime: 1, endTime: 2 }] }), status: 'failed' }],
    ],
  ])('reads nothing from %s, so the lyrics stay unsynced', (_, steps) => {
    expect(readTranscriptionWords(steps)).toEqual([]);
  });
});

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

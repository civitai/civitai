import { describe, expect, it } from 'vitest';
import {
  buildSongDetails,
  parseLyricLines,
  readSongConcept,
  songAllowsRemix,
} from '~/shared/form-graph/generation/audio/song-metadata';

describe('parseLyricLines', () => {
  it('splits on newlines into unsynced lines, dropping blanks and trimming', () => {
    expect(parseLyricLines('[Verse]\n  hello there \r\n\n\nworld')).toEqual([
      { t: null, text: '[Verse]' },
      { t: null, text: 'hello there' },
      { t: null, text: 'world' },
    ]);
  });

  it('returns undefined when there is nothing to show', () => {
    expect(parseLyricLines('  \n ')).toBeUndefined();
    expect(parseLyricLines(undefined)).toBeUndefined();
    expect(parseLyricLines(42)).toBeUndefined();
  });
});

describe('buildSongDetails', () => {
  it('reads a custom-mode song from the form params', () => {
    expect(
      buildSongDetails({ title: ' Night Drive ', lyrics: 'la\nla', bpm: 128, prompt: 'synthwave' })
    ).toEqual({
      title: 'Night Drive',
      lyrics: [
        { t: null, text: 'la' },
        { t: null, text: 'la' },
      ],
      bpm: 128,
    });
  });

  it('fills what a simple-mode form never holds from the drafted concept', () => {
    expect(
      buildSongDetails(
        { prompt: 'a sad song' },
        { lyrics: '[Chorus]\nrain', bpm: 90, key: 'A minor' }
      )
    ).toEqual({
      lyrics: [
        { t: null, text: '[Chorus]' },
        { t: null, text: 'rain' },
      ],
      bpm: 90,
      key: 'A minor',
    });
  });

  it('prefers what the user typed over the drafted concept', () => {
    const details = buildSongDetails({ lyrics: 'mine', bpm: 100 }, { lyrics: 'drafted', bpm: 90 });
    expect(details.lyrics).toEqual([{ t: null, text: 'mine' }]);
    expect(details.bpm).toBe(100);
  });

  it('drops a drafted key longer than a song may store', () => {
    expect(buildSongDetails({}, { key: 'A minor, then a long modulation' })).toEqual({});
  });

  it('drops values of the wrong shape instead of passing them on', () => {
    expect(buildSongDetails({ title: '   ', bpm: 'fast', lyrics: 7 }, { key: 3 })).toEqual({});
    expect(buildSongDetails(undefined)).toEqual({});
  });
});

describe('readSongConcept', () => {
  it('reads the parsed output of the drafting chat step', () => {
    const steps = [
      { $type: 'imageGen', output: { images: [] } },
      {
        $type: 'chatCompletion',
        output: { parsed: { lyrics: 'la', bpm: 120, key: 'C', musicDescription: 'x' } },
      },
      { $type: 'aceStepAudio', output: {} },
    ];
    expect(readSongConcept(steps)).toEqual({ lyrics: 'la', bpm: 120, key: 'C' });
  });

  it('is undefined when there is no usable chat step', () => {
    expect(readSongConcept([{ $type: 'aceStepAudio' }])).toBeUndefined();
    expect(
      readSongConcept([{ $type: 'chatCompletion', output: { parsed: null } }])
    ).toBeUndefined();
    expect(readSongConcept(undefined)).toBeUndefined();
  });
});

describe('songAllowsRemix', () => {
  it('is false only when the owner turned remixing off', () => {
    expect(songAllowsRemix({ duration: 1, allowRemix: false })).toBe(false);
    expect(songAllowsRemix({ duration: 1, allowRemix: true })).toBe(true);
    expect(songAllowsRemix({ duration: 1 })).toBe(true);
    expect(songAllowsRemix(null)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  alignLyrics,
  lyricsAreSynced,
  type TranscribedWord,
} from '~/server/services/audio-scan/lyric-alignment';

/** Words spaced 0.5s apart starting at `start`, as a transcriber reports them. */
const say = (text: string, start: number): TranscribedWord[] =>
  text.split(' ').map((word, i) => ({
    text: ` ${word}`,
    startTime: start + i * 0.5,
    endTime: start + i * 0.5 + 0.4,
  }));

const lines = (...texts: string[]) => texts.map((text) => ({ t: null, text }));

describe('lyricsAreSynced', () => {
  it('is true only when every line has a numeric offset', () => {
    expect(
      lyricsAreSynced([
        { t: 1, text: 'a' },
        { t: 0, text: 'b' },
      ])
    ).toBe(true);
    expect(
      lyricsAreSynced([
        { t: 1, text: 'a' },
        { t: null, text: 'b' },
      ])
    ).toBe(false);
  });

  it('is false with no lyrics, so there is something to build', () => {
    expect(lyricsAreSynced(undefined)).toBe(false);
    expect(lyricsAreSynced([])).toBe(false);
  });
});

describe('alignLyrics with stored lyrics', () => {
  it('places each line at the start of its first word', () => {
    const words = [...say('hello darkness my old friend', 10), ...say('i have come to talk', 14)];

    const result = alignLyrics({
      lyrics: lines('Hello darkness, my old friend', 'I have come to talk'),
      words,
    });

    expect(result).toEqual([
      { t: 10, text: 'Hello darkness, my old friend' },
      { t: 14, text: 'I have come to talk' },
    ]);
  });

  it('tolerates misheard words', () => {
    const words = [...say('hello darkness my old friend', 10), ...say('i have come two talk', 14)];

    const result = alignLyrics({
      lyrics: lines('Hello darkness, my old friend', 'I have come to talk'),
      words,
    });

    expect(result.map((l) => l.t)).toEqual([10, 14]);
  });

  it('keeps the stored text, never the transcription', () => {
    const result = alignLyrics({
      lyrics: lines("Don't stop believin'"),
      words: say('dont stop believing', 3),
    });

    expect(result).toEqual([{ t: 3, text: "Don't stop believin'" }]);
  });

  it('places a repeated chorus at each of its occurrences', () => {
    const chorus = 'we will rock you tonight';
    const words = [
      ...say('walking down the road alone', 5),
      ...say(chorus, 20),
      ...say('turning back the page again', 30),
      ...say(chorus, 45),
    ];

    const result = alignLyrics({
      lyrics: lines(
        'Walking down the road alone',
        'We will rock you tonight',
        'Turning back the page again',
        'We will rock you tonight'
      ),
      words,
    });

    expect(result.map((l) => l.t)).toEqual([5, 20, 30, 45]);
  });

  it('skips section tags without letting them break the lines around them', () => {
    const words = [...say('first line of verse', 8), ...say('big loud chorus line', 20)];

    const result = alignLyrics({
      lyrics: lines('[Verse 1]', 'First line of verse', '(Chorus)', 'Big loud chorus line'),
      words,
    });

    expect(result).toEqual([
      { t: null, text: '[Verse 1]' },
      { t: 8, text: 'First line of verse' },
      { t: null, text: '(Chorus)' },
      { t: 20, text: 'Big loud chorus line' },
    ]);
  });

  it('leaves a line the singer never sang unplaced and still places the ones after it', () => {
    const words = [...say('line one is here', 4), ...say('line three arrives now', 12)];

    const result = alignLyrics({
      lyrics: lines(
        'Line one is here',
        'Completely different words nobody sings',
        'Line three arrives now'
      ),
      words,
    });

    expect(result.map((l) => l.t)).toEqual([4, null, 12]);
  });

  it('never places a line before the one above it', () => {
    const words = [...say('alpha beta gamma delta', 2), ...say('epsilon zeta eta theta', 9)];

    const result = alignLyrics({
      lyrics: lines('Epsilon zeta eta theta', 'Alpha beta gamma delta'),
      words,
    });

    const placed = result.map((l) => l.t).filter((t): t is number => t !== null);
    expect(placed).toEqual([...placed].sort((a, b) => a - b));
  });

  it('leaves every line unsynced when nothing was transcribed', () => {
    const stored = lines('some words here', 'and some more');

    expect(alignLyrics({ lyrics: stored, words: [] })).toEqual(stored);
  });

  it('does not run the alignment when the lyrics are already synced', () => {
    const synced = [
      { t: 1.5, text: 'already timed' },
      { t: 4, text: 'also timed' },
    ];

    expect(alignLyrics({ lyrics: synced, words: say('totally unrelated speech', 30) })).toEqual(
      synced
    );
  });
});

describe('alignLyrics without stored lyrics', () => {
  it('builds lines from the transcription, breaking at pauses', () => {
    const words = [...say('first phrase here', 2), ...say('second phrase after a pause', 9)];

    const result = alignLyrics({ lyrics: undefined, words });

    expect(result).toEqual([
      { t: 2, text: 'first phrase here' },
      { t: 9, text: 'second phrase after a pause' },
    ]);
  });

  it('breaks at sentence punctuation even without a pause', () => {
    const words = [
      { text: ' Hello', startTime: 1, endTime: 1.4 },
      { text: ' there.', startTime: 1.5, endTime: 1.9 },
      { text: ' Goodbye', startTime: 2, endTime: 2.4 },
      { text: ' now', startTime: 2.5, endTime: 2.9 },
    ];

    expect(alignLyrics({ lyrics: [], words })).toEqual([
      { t: 1, text: 'Hello there.' },
      { t: 2, text: 'Goodbye now' },
    ]);
  });

  it('returns nothing when there is nothing to build from', () => {
    expect(alignLyrics({ lyrics: undefined, words: [] })).toEqual([]);
  });
});

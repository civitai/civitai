import { describe, expect, it } from 'vitest';
import { alignLyrics, type TranscribedWord } from '~/server/services/audio-scan/lyric-alignment';

/** Words spaced 0.5s apart starting at `start`, as a transcriber reports them. */
const say = (text: string, start: number): TranscribedWord[] =>
  text.split(' ').map((word, i) => ({
    text: ` ${word}`,
    startTime: start + i * 0.5,
    endTime: start + i * 0.5 + 0.4,
  }));

const lines = (...texts: string[]) => texts.map((text) => ({ t: null, text }));

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

  it('discards times the client sent: a placed line gets the transcribed time, an unplaced one null', () => {
    const clientTimed = [
      { t: 99, text: 'Line one is here' },
      { t: 100, text: 'Never sung by anybody at all' },
    ];

    const result = alignLyrics({ lyrics: clientTimed, words: say('line one is here', 4) });

    expect(result).toEqual([
      { t: 4, text: 'Line one is here' },
      { t: null, text: 'Never sung by anybody at all' },
    ]);
  });

  it('discards every client time when nothing was transcribed', () => {
    const result = alignLyrics({ lyrics: [{ t: 5, text: 'timed by the client' }], words: [] });

    expect(result).toEqual([{ t: null, text: 'timed by the client' }]);
  });

  it('aligns a realistic long song, with misheard words and a repeated chorus', () => {
    const verse = (n: number) =>
      [0, 1, 2, 3].map((l) => `verse ${n} line ${l} walking through golden morning light`);
    const chorus = [
      'oh we are shining brighter than the stars tonight',
      'hold on to me and never let me go',
      'we are shining brighter than the stars tonight',
      'singing out loud until the morning comes',
    ];
    const text = [...[1, 2, 3].flatMap((n) => ['[Verse]', ...verse(n), '[Chorus]', ...chorus])];
    const sung = text.filter((l) => !l.startsWith('['));
    const words: TranscribedWord[] = [];
    let clock = 10;
    sung.forEach((line, i) => {
      // Every fifth line has a word the transcriber got wrong.
      const heard =
        i % 5 === 0 ? line.replace('golden', 'goldie').replace('shining', 'shinning') : line;
      words.push(...say(heard, clock));
      clock += heard.split(' ').length * 0.5 + 1.5;
    });

    const result = alignLyrics({ lyrics: lines(...text), words });

    const placed = result.filter((l) => l.t !== null && !l.text.startsWith('['));
    expect(placed.length).toBeGreaterThanOrEqual(sung.length * 0.9);
    const times = placed.map((l) => l.t as number);
    expect(times).toEqual([...times].sort((a, b) => a - b));
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

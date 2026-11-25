import { describe, expect, it } from 'vitest';
import {
  createPlayIntent,
  createSongPlayer,
  songLoading,
  isSeek,
  playingLyricIndex,
  seekMarkers,
  uniqueCardKey,
  type SongMedia,
} from '../song-player';

/**
 * The moderator song player (Music T10, docs/features/music.md "Moderating songs"): nothing plays
 * until a moderator asks, one song plays at a time, and each song starts at the last volume.
 */

type FakeMedia = Omit<SongMedia, 'paused'> & { paused: boolean; plays: number };

/** An `<audio>` element as far as the player reads it; `play` fires the element's `play` event. */
function fakeMedia(player: ReturnType<typeof createSongPlayer>): FakeMedia {
  const media: FakeMedia = {
    paused: true,
    currentTime: 0,
    volume: 1,
    plays: 0,
    play() {
      media.paused = false;
      media.plays++;
      player.played(media);
    },
    pause() {
      media.paused = true;
    },
  };
  return media;
}

function memoryStore(initial: number | null = null) {
  const store = {
    value: initial,
    read: () => store.value,
    write: (v: number) => {
      store.value = v;
    },
  };
  return store;
}

describe('the moderator song player', () => {
  it('plays nothing on its own: a card on the page starts paused at 0:00', () => {
    const player = createSongPlayer(memoryStore());
    const a = fakeMedia(player);
    player.register(1, a);
    expect(a.plays).toBe(0);
    expect(a.paused).toBe(true);
  });

  it('plays one song at a time: starting one pauses the other', () => {
    const player = createSongPlayer(memoryStore());
    const a = fakeMedia(player);
    const b = fakeMedia(player);
    player.register(1, a);
    player.register(2, b);
    a.play();
    b.play();
    expect([a.paused, b.paused]).toEqual([true, false]);
  });

  it('starts every song at the last volume a moderator chose', () => {
    const store = memoryStore();
    const player = createSongPlayer(store);
    const a = fakeMedia(player);
    player.register(1, a);
    a.volume = 0.3;
    player.volumeChanged(a);

    const b = fakeMedia(player);
    player.register(2, b);
    expect(b.volume).toBe(0.3);
    // A reload reads it back.
    const after = fakeMedia(createSongPlayer(store));
    createSongPlayer(store).register(3, after);
    expect(after.volume).toBe(0.3);
  });

  it("playAt starts a card's song at a time, pausing whatever else plays", () => {
    const player = createSongPlayer(memoryStore());
    const a = fakeMedia(player);
    const b = fakeMedia(player);
    player.register(1, a);
    player.register(2, b);
    a.play();

    expect(player.playAt(2, 83)).toBe(true);
    expect(b).toMatchObject({ currentTime: 83, paused: false });
    expect(a.paused).toBe(true);
    expect(player.playAt(99, 10)).toBe(false);
  });

  it('playAt picks the card named, where the same song shows on two', () => {
    const player = createSongPlayer(memoryStore());
    const first = fakeMedia(player);
    const second = fakeMedia(player);
    player.register(1, first, 'report-10');
    player.register(1, second, 'report-11');

    player.playAt(1, 12, 'report-11');
    expect([first.paused, second.paused, second.currentTime]).toEqual([true, false, 12]);
  });

  it('a lyric click drives its own card, even where no caller gave the card a key', () => {
    const player = createSongPlayer(memoryStore());
    const first = fakeMedia(player);
    const second = fakeMedia(player);
    const [firstKey, secondKey] = [uniqueCardKey(), uniqueCardKey()];
    expect(firstKey).not.toBe(secondKey);
    player.register(1, first, firstKey);
    player.register(1, second, secondKey);
    first.play();

    player.playAt(1, 30, secondKey);
    expect([first.paused, second.paused, second.currentTime]).toEqual([true, false, 30]);
  });

  it('playAt tells the card it asked for play at that time, and plays nothing on a card that refuses', () => {
    const player = createSongPlayer(memoryStore());
    const media = fakeMedia(player);
    const asked: number[] = [];
    let failed = false;
    player.register(7, media, 'card', {
      wantPlay: (at) => {
        if (failed) return false;
        asked.push(at);
        return true;
      },
    });
    expect(player.playAt(7, 42)).toBe(true);
    expect(asked).toEqual([42]);
    expect(media.plays).toBe(1);

    failed = true;
    media.pause();
    expect(player.playAt(7, 10)).toBe(false);
    expect(media.plays).toBe(1);
    expect(media.currentTime).toBe(42);
  });

  it('stops a song whose card leaves the page', () => {
    const player = createSongPlayer(memoryStore());
    const a = fakeMedia(player);
    const unregister = player.register(1, a);
    a.play();
    unregister();
    expect(a.paused).toBe(true);
    expect(player.playAt(1, 0)).toBe(false);
  });
});

describe('createPlayIntent', () => {
  // A card swaps its source when the CDN refuses the song; the stored copy goes on playing only if
  // the moderator asked for play and has not paused since.
  it('resumes after a source swap only a song the moderator is playing', () => {
    const intent = createPlayIntent();
    expect(intent.resumeAfterSwap()).toBe(false);
    intent.requested();
    expect(intent.resumeAfterSwap()).toBe(true);
  });

  it('does not resume a song the moderator paused, or one that ended', () => {
    const intent = createPlayIntent();
    intent.requested();
    intent.paused();
    expect(intent.resumeAfterSwap()).toBe(false);
  });

  // A report's time or a lyric line asked for play at a time the CDN copy never reached: the stored
  // copy starts there, not at 0:00. Once the song is playing, a later swap goes on from wherever.
  it('resumes at the time asked for until the song has started', () => {
    const intent = createPlayIntent();
    intent.requested(84);
    expect(intent.resumeAt()).toBe(84);
    intent.started();
    expect(intent.resumeAt()).toBeNull();
    intent.requested();
    expect(intent.resumeAt()).toBeNull();
    intent.requested(30);
    intent.paused();
    expect(intent.resumeAt()).toBeNull();
  });
});

describe('isSeek, between the seek bar and the playing song', () => {
  // The bar's value follows the playhead; echoing it back as a seek restarts buffering at every
  // tick, so the song never advances.
  it('ignores the bar echoing the playhead back', () => {
    expect(isSeek(12.3, 12.25)).toBe(false);
    expect(isSeek(12.25, 12.3)).toBe(false);
  });

  it('takes a move of the bar as a seek', () => {
    expect(isSeek(30, 12.3)).toBe(true);
    expect(isSeek(0, 12.3)).toBe(true);
  });
});

describe('songLoading', () => {
  // A removed song from storage starts loading only on play, so the button must say so.
  it('is loading from a play until the song can play, and while it waits for data', () => {
    expect(songLoading(false, 'play')).toBe(true);
    expect(songLoading(true, 'playing')).toBe(false);
    expect(songLoading(false, 'waiting')).toBe(true);
    expect(songLoading(true, 'canplay')).toBe(false);
  });

  it('stops loading on a pause or an error, so a refused file leaves no spinner', () => {
    expect(songLoading(true, 'pause')).toBe(false);
    expect(songLoading(true, 'error')).toBe(false);
  });
});

describe('the playing lyric line', () => {
  const lines = [
    { t: null, text: '[Verse]' },
    { t: 5000, text: 'one' },
    { t: null, text: 'untimed' },
    { t: 10000, text: 'two' },
    { t: 15000, text: 'three' },
  ];

  it('is the last timed line that has started, an untimed one never', () => {
    expect(playingLyricIndex(lines, 0)).toBe(-1);
    expect(playingLyricIndex(lines, 5)).toBe(1);
    expect(playingLyricIndex(lines, 9.9)).toBe(1);
    expect(playingLyricIndex(lines, 12)).toBe(3);
    expect(playingLyricIndex(lines, 300)).toBe(4);
  });

  it('is none for lyrics with no times', () => {
    expect(playingLyricIndex([{ t: null, text: 'a' }], 30)).toBe(-1);
  });
});

describe('report markers on the seek bar', () => {
  it('sits each reported time at its share of the song, earliest first, the reason as its title', () => {
    const marks = seekMarkers(
      [
        { timeSec: 150, label: 'Hateful lyrics' },
        { timeSec: 30, label: 'Spam' },
      ],
      200
    );
    expect(marks).toEqual([
      { timeSec: 30, percent: 15, title: 'Report at 0:30: Spam' },
      { timeSec: 150, percent: 75, title: 'Report at 2:30: Hateful lyrics' },
    ]);
  });

  it('draws one marker for reports at the same second, naming every reason once', () => {
    const marks = seekMarkers(
      [
        { timeSec: 84, label: 'Spam' },
        { timeSec: 84.6, label: 'Hateful lyrics' },
        { timeSec: 84, label: 'Spam' },
      ],
      168
    );
    expect(marks).toEqual([
      { timeSec: 84, percent: 50, title: 'Report at 1:24: Spam · Hateful lyrics' },
    ]);
  });

  it('skips reports without a time and times outside the song, so none is drawn off the bar', () => {
    const marks = seekMarkers(
      [
        { timeSec: null, label: 'Spam' },
        { timeSec: 250, label: 'Spam' },
        { timeSec: -1, label: 'Spam' },
        { timeSec: 200, label: 'Spam' },
      ],
      200
    );
    expect(marks).toEqual([{ timeSec: 200, percent: 100, title: 'Report at 3:20: Spam' }]);
  });

  it("keeps a report filed at the stored length on the bar's end when the file is a little shorter", () => {
    expect(seekMarkers([{ timeSec: 200, label: 'Spam' }], 199.4)).toEqual([
      { timeSec: 200, percent: 100, title: 'Report at 3:20: Spam' },
    ]);
  });

  it('draws nothing while the song length is unknown', () => {
    for (const duration of [0, Number.NaN, Infinity])
      expect(seekMarkers([{ timeSec: 10, label: 'Spam' }], duration)).toEqual([]);
  });
});

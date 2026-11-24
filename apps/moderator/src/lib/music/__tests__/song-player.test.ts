import { describe, expect, it } from 'vitest';
import {
  createPlayIntent,
  createSongPlayer,
  isSeek,
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

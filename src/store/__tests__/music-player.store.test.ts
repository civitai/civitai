import { describe, expect, it } from 'vitest';
import type { MusicTrack } from '~/store/music-player.store';
import { createMusicPlayerStore, TIMED_COMMENTS_KEY } from '~/store/music-player.store';

const track = (id: number, durationSec = 200): MusicTrack => ({
  id,
  url: `song-${id}.mp3`,
  title: `Song ${id}`,
  durationSec,
  creator: { id: 100 + id, username: `artist${id}` },
});

const [a, b, c, d, e] = [1, 2, 3, 4, 5].map((id) => track(id));

/** A store with a hand-driven clock and a fixed random source. */
function setup({ random = () => 0 }: { random?: () => number } = {}) {
  let clock = 1_000_000;
  const store = createMusicPlayerStore({ random, now: () => clock });
  return {
    get: store.getState,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

const ids = (tracks: MusicTrack[]) => tracks.map((t) => t.id);

describe('playing a song', () => {
  it('plays it in the bar and leaves Up next empty', () => {
    const { get } = setup();
    get().playTrack(a);
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(true);
    expect(get().view).toBe('bar');
    expect(get().queued).toEqual([]);
    expect(get().list).toEqual([]);
    expect(get().listName).toBeNull();
  });

  it('from a list, makes the rest of the list Up next in order', () => {
    const { get } = setup();
    get().playTrack(b, { list: { name: 'Night drive', tracks: [a, b, c, d] } });
    expect(get().current?.id).toBe(b.id);
    expect(ids(get().list)).toEqual([c.id, d.id]);
    expect(get().listName).toBe('Night drive');
  });

  it('keeps the player minimized when it already is', () => {
    const { get } = setup();
    get().playTrack(a);
    get().minimize();
    get().playTrack(b);
    expect(get().view).toBe('minimized');
  });

  it('pauses and resumes', () => {
    const { get } = setup();
    get().playTrack(a);
    get().pause();
    expect(get().playing).toBe(false);
    get().togglePlay();
    expect(get().playing).toBe(true);
  });
});

describe('next and previous', () => {
  it('next plays the songs you queued before the rest of the list', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c] } });
    get().addToUpNext(e);
    get().next();
    expect(get().current?.id).toBe(e.id);
    get().next();
    expect(get().current?.id).toBe(b.id);
    get().next();
    expect(get().current?.id).toBe(c.id);
  });

  it('when the last song ends, playback stops on it at the start', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    get().ended();
    const { playbackId } = get().playback!;
    get().ended();
    expect(get().current?.id).toBe(b.id);
    expect(get().playing).toBe(false);
    expect(get().view).toBe('bar');
    // A new playback: the song will start again from 0:00.
    expect(get().playback?.playbackId).not.toBe(playbackId);
  });

  it('previous within the first 3 seconds goes back to the song played before', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c] } });
    get().next();
    get().reportTime(2);
    get().previous();
    expect(get().current?.id).toBe(a.id);
    // The song you left is next again.
    expect(ids(get().list)).toEqual([b.id, c.id]);
  });

  it('previous after 3 seconds restarts the song', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    get().next();
    const { playbackId } = get().playback!;
    get().reportTime(12);
    get().previous();
    expect(get().current?.id).toBe(b.id);
    expect(get().playback?.playbackId).not.toBe(playbackId);
  });

  it('previous on the first song restarts it', () => {
    const { get } = setup();
    get().playTrack(a);
    const { playbackId } = get().playback!;
    get().previous();
    expect(get().current?.id).toBe(a.id);
    expect(get().playback?.playbackId).not.toBe(playbackId);
  });
});

describe('a song that fails to load', () => {
  it('stays in the bar, not playing, and can be skipped or closed', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    get().markError();
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(false);
    expect(get().error).toBe(true);
    expect(get().view).toBe('bar');

    get().next();
    expect(get().current?.id).toBe(b.id);
    expect(get().error).toBe(false);
    expect(get().playing).toBe(true);

    get().markError();
    get().close();
    expect(get().current).toBeNull();
    expect(get().error).toBe(false);
  });
});

describe('Up next', () => {
  it('Add to up next appends, Play next puts the song on top, and neither adds a song twice', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    get().addToUpNext(c);
    get().addToUpNext(d);
    get().playNext(e);
    expect(ids(get().queued)).toEqual([e.id, c.id, d.id]);

    get().addToUpNext(c);
    get().playNext(d);
    get().addToUpNext(b);
    expect(ids(get().queued)).toEqual([e.id, c.id, d.id]);
    expect(ids(get().list)).toEqual([b.id]);
  });

  it('with nothing loaded, adding a song loads it paused in the bar', () => {
    const { get } = setup();
    get().addToUpNext(a);
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(false);
    expect(get().view).toBe('bar');
    expect(get().queued).toEqual([]);
  });

  it('Clear empties both sections and leaves the playing song playing', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c] } });
    get().addToUpNext(d);
    get().clearUpNext();
    expect(get().queued).toEqual([]);
    expect(get().list).toEqual([]);
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(true);
  });

  it('remove takes one song out of Up next', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c] } });
    get().addToUpNext(d);
    get().removeFromUpNext(b.id);
    get().removeFromUpNext(d.id);
    expect(get().queued).toEqual([]);
    expect(ids(get().list)).toEqual([c.id]);
  });

  it('clicking a row plays that song now and takes it out of Up next', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c, d] } });
    get().playFromUpNext(c.id);
    expect(get().current?.id).toBe(c.id);
    expect(ids(get().list)).toEqual([b.id, d.id]);
  });

  it('reorders within a section and moves a list song into Queued by you, not back', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c, d] } });
    get().addToUpNext(e);

    get().moveInUpNext(d.id, 'list', 0);
    expect(ids(get().list)).toEqual([d.id, b.id, c.id]);

    get().moveInUpNext(c.id, 'queued', 0);
    expect(ids(get().queued)).toEqual([c.id, e.id]);
    expect(ids(get().list)).toEqual([d.id, b.id]);

    get().moveInUpNext(e.id, 'list', 0);
    expect(ids(get().queued)).toEqual([c.id, e.id]);
    expect(ids(get().list)).toEqual([d.id, b.id]);

    get().next();
    expect(get().current?.id).toBe(c.id);
  });
});

describe('shuffle and repeat', () => {
  // Fisher-Yates with random() = 0 swaps every position with the first: [b, c, d] -> [c, d, b].
  it('shuffle plays Up next in a new order, the order the panel shows', () => {
    const { get } = setup({ random: () => 0 });
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c, d] } });
    get().toggleShuffle();
    expect(get().shuffle).toBe(true);
    const shuffled = ids(get().list);
    expect([...shuffled].sort()).toEqual([b.id, c.id, d.id]);
    expect(shuffled).not.toEqual([b.id, c.id, d.id]);

    get().next();
    expect(get().current?.id).toBe(shuffled[0]);
  });

  it('turning shuffle off puts the songs not yet played back in their order', () => {
    const { get } = setup({ random: () => 0 });
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c, d, e] } });
    get().toggleShuffle();
    get().next();
    const played = get().current!.id;
    get().toggleShuffle();
    expect(get().shuffle).toBe(false);
    expect(ids(get().list)).toEqual([b.id, c.id, d.id, e.id].filter((id) => id !== played));
  });

  it('shuffles the rest of a list started while shuffle is on', () => {
    const { get } = setup({ random: () => 0 });
    get().toggleShuffle();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c, d] } });
    expect(ids(get().list)).not.toEqual([b.id, c.id, d.id]);
    get().toggleShuffle();
    expect(ids(get().list)).toEqual([b.id, c.id, d.id]);
  });

  it('repeat cycles off, all, one', () => {
    const { get } = setup();
    expect(get().repeat).toBe('off');
    get().cycleRepeat();
    expect(get().repeat).toBe('all');
    get().cycleRepeat();
    expect(get().repeat).toBe('one');
    get().cycleRepeat();
    expect(get().repeat).toBe('off');
  });

  it('repeat all starts the played songs again after the last one', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b, c] } });
    get().cycleRepeat();
    get().ended();
    get().ended();
    expect(get().current?.id).toBe(c.id);
    get().ended();
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(true);
    expect(ids(get().list)).toEqual([b.id, c.id]);
  });

  it('repeat one replays the song when it ends, as a new playback', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    get().cycleRepeat();
    get().cycleRepeat();
    const { playbackId } = get().playback!;
    get().ended();
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(true);
    expect(get().playback?.playbackId).not.toBe(playbackId);

    // Next still moves on.
    get().next();
    expect(get().current?.id).toBe(b.id);
  });
});

describe('volume and the minimized player', () => {
  it('keeps volume inside 0..1 and toggles mute', () => {
    const { get } = setup();
    get().setVolume(1.4);
    expect(get().volume).toBe(1);
    get().setVolume(0.3);
    expect(get().volume).toBe(0.3);
    get().toggleMute();
    expect(get().muted).toBe(true);
    get().toggleMute();
    expect(get().muted).toBe(false);
  });

  it('minimize and expand keep the dragged position', () => {
    const { get } = setup();
    get().playTrack(a);
    get().minimize();
    expect(get().view).toBe('minimized');
    get().setMinimizedPosition({ x: 0.8, y: 0.1 });
    get().expand();
    expect(get().view).toBe('bar');
    get().minimize();
    expect(get().minimizedPosition).toEqual({ x: 0.8, y: 0.1 });
  });
});

describe('closing the player', () => {
  it('stops playback and clears the song, Up next and the minimized position', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    get().addToUpNext(c);
    get().minimize();
    get().setMinimizedPosition({ x: 0.5, y: 0.5 });
    get().close();
    expect(get().current).toBeNull();
    expect(get().playing).toBe(false);
    expect(get().queued).toEqual([]);
    expect(get().list).toEqual([]);
    expect(get().listName).toBeNull();
    expect(get().view).toBe('closed');
    expect(get().minimizedPosition).toBeNull();
    expect(get().playback).toBeNull();
  });

  it('a song played after closing has no history to go back to', () => {
    const { get } = setup();
    get().playTrack(a);
    get().close();
    get().playTrack(b);
    const { playbackId } = get().playback!;
    get().previous();
    expect(get().current?.id).toBe(b.id);
    expect(get().playback?.playbackId).not.toBe(playbackId);
  });
});

describe('listen progress', () => {
  it('describes the current playback of the current song', () => {
    const { get } = setup();
    get().playTrack(track(7, 95));
    expect(get().playback).toMatchObject({ songId: 7, durationSec: 95, listenedSec: 0 });

    get().reportDuration(96.4);
    expect(get().playback?.durationSec).toBe(96.4);
  });

  it('counts seconds actually played; seeking forward adds nothing', () => {
    const { get, advance } = setup();
    get().playTrack(a);
    get().reportTime(0);
    for (let s = 1; s <= 10; s++) {
      advance(1);
      get().reportTime(s);
    }
    advance(0.25);
    get().reportTime(199);
    expect(get().playback?.listenedSec).toBeCloseTo(10, 0);
  });

  it('does not advance while paused', () => {
    const { get, advance } = setup();
    get().playTrack(a);
    get().reportTime(0);
    advance(4);
    get().reportTime(4);
    get().pause();
    advance(30);
    get().reportTime(60);
    expect(get().playback?.listenedSec).toBeCloseTo(4, 5);

    get().resume();
    get().reportTime(60);
    advance(1);
    get().reportTime(61);
    expect(get().playback?.listenedSec).toBeCloseTo(5, 5);
  });

  it('repeat one starts a new playback with nothing listened', () => {
    const { get, advance } = setup();
    get().playTrack(a);
    get().cycleRepeat();
    get().cycleRepeat();
    get().reportTime(0);
    advance(5);
    get().reportTime(5);
    const { playbackId } = get().playback!;
    get().ended();
    expect(get().playback?.playbackId).not.toBe(playbackId);
    expect(get().playback?.listenedSec).toBe(0);
    expect(get().playback?.songId).toBe(a.id);
  });

  it('a new song starts a new playback', () => {
    const { get } = setup();
    get().playTrack(a, { list: { name: 'Post', tracks: [a, b] } });
    const { playbackId } = get().playback!;
    get().next();
    expect(get().playback).toMatchObject({ songId: b.id, listenedSec: 0 });
    expect(get().playback?.playbackId).not.toBe(playbackId);
  });
});

describe('playing from a list', () => {
  it('makes the songs after the chosen one Up next, in list order, under the list name', () => {
    const { get } = setup();
    get().playFromList({ name: 'Rising this week', tracks: [a, b, c, d, e], index: 1 });
    expect(get().current?.id).toBe(b.id);
    expect(get().playing).toBe(true);
    expect(ids(get().list)).toEqual([c.id, d.id, e.id]);
    expect(get().listName).toBe('Rising this week');
  });

  it('the last song of the list leaves the list section empty', () => {
    const { get } = setup();
    get().playFromList({ name: 'Playlist', tracks: [a, b, c], index: 2 });
    expect(get().current?.id).toBe(c.id);
    expect(get().list).toEqual([]);
  });

  it('a list of one song leaves Up next empty', () => {
    const { get } = setup();
    get().playFromList({ name: 'Post', tracks: [a], index: 0 });
    expect(get().current?.id).toBe(a.id);
    expect(get().list).toEqual([]);
  });

  it('keeps Queued by you ahead of the list and does not repeat a queued song in it', () => {
    const { get } = setup();
    get().playTrack(e);
    get().addToUpNext(d);
    get().playFromList({ name: 'Feed', tracks: [a, b, c, d], index: 0 });
    expect(ids(get().queued)).toEqual([d.id]);
    expect(ids(get().list)).toEqual([b.id, c.id]);
    get().next();
    expect(get().current?.id).toBe(d.id);
    get().next();
    expect(get().current?.id).toBe(b.id);
  });

  it('a song listed twice is in Up next once', () => {
    const { get } = setup();
    get().playFromList({ name: 'Feed', tracks: [a, b, c, b], index: 0 });
    expect(ids(get().list)).toEqual([b.id, c.id]);
  });

  it('picks the clicked position, not the first song with that id', () => {
    const { get } = setup();
    get().playFromList({ name: 'Feed', tracks: [a, b, a, c], index: 2 });
    expect(get().current?.id).toBe(a.id);
    expect(ids(get().list)).toEqual([c.id]);
  });

  it('an index outside the list does nothing', () => {
    const { get } = setup();
    get().playFromList({ name: 'Feed', tracks: [a, b], index: 5 });
    expect(get().current).toBeNull();
  });
});

describe('restoring the last song after a reload', () => {
  it('shows the bar with the song paused at the saved position', () => {
    const { get } = setup();
    get().restore({ track: a, positionSec: 42 });
    expect(get().current?.id).toBe(a.id);
    expect(get().playing).toBe(false);
    expect(get().view).toBe('bar');
    expect(get().playback).toMatchObject({ songId: a.id, listenedSec: 0, startAtSec: 42 });
    expect(get().queued).toEqual([]);
    expect(get().list).toEqual([]);
  });

  it('keeps the saved position inside the song', () => {
    const { get } = setup();
    get().restore({ track: track(9, 100), positionSec: 250 });
    expect(get().playback?.startAtSec).toBe(100);
    get().close();
    get().restore({ track: a, positionSec: -3 });
    expect(get().playback?.startAtSec).toBe(0);
  });

  it('previous restarts a song restored more than 3 s in', () => {
    const { get } = setup();
    get().restore({ track: a, positionSec: 42 });
    const { playbackId } = get().playback!;
    get().previous();
    expect(get().current?.id).toBe(a.id);
    expect(get().playback?.playbackId).not.toBe(playbackId);
    expect(get().playback?.startAtSec).toBe(0);
  });

  it('does not replace a song the listener already started', () => {
    const { get } = setup();
    get().playTrack(b);
    get().restore({ track: a, positionSec: 42 });
    expect(get().current?.id).toBe(b.id);
    expect(get().playing).toBe(true);
  });

  it('a song played after it starts from the beginning', () => {
    const { get } = setup();
    get().restore({ track: a, positionSec: 42 });
    get().playTrack(b);
    expect(get().playback?.startAtSec).toBe(0);
  });
});

describe('timed comments on the waveform', () => {
  const memory = (initial?: string) => {
    const map = new Map<string, string>(initial ? [[TIMED_COMMENTS_KEY, initial]] : []);
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  };

  it('are shown until the listener turns them off, and the choice is kept for the next visit', () => {
    const storage = memory();
    const first = createMusicPlayerStore({ storage });
    expect(first.getState().showTimedComments).toBe(true);
    first.getState().toggleTimedComments();
    expect(first.getState().showTimedComments).toBe(false);

    const next = createMusicPlayerStore({ storage });
    expect(next.getState().showTimedComments).toBe(false);
    next.getState().toggleTimedComments();
    expect(createMusicPlayerStore({ storage }).getState().showTimedComments).toBe(true);
  });

  it('stay on when storage is blocked or holds something else', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createMusicPlayerStore({ storage: blocked });
    expect(store.getState().showTimedComments).toBe(true);
    store.getState().toggleTimedComments();
    expect(store.getState().showTimedComments).toBe(false);
    expect(createMusicPlayerStore({ storage: memory('maybe') }).getState().showTimedComments).toBe(
      true
    );
  });

  it('survive closing the player', () => {
    const store = createMusicPlayerStore({ storage: memory() });
    store.getState().toggleTimedComments();
    store.getState().playTrack(a);
    store.getState().close();
    expect(store.getState().showTimedComments).toBe(false);
  });
});

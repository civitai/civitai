import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { MusicTrack } from '~/store/music-player.store';
import { createMusicPlayerStore } from '~/store/music-player.store';
import {
  MUSIC_PLAYER_RESUME_KEY,
  persistMusicPlayer,
  readSavedMusicPlayer,
  resumeMusicPlayer,
} from '~/store/music-player-resume';

const track = (id: number, durationSec = 200): MusicTrack => ({
  id,
  url: `song-${id}.mp3`,
  title: `Song ${id}`,
  durationSec,
  creator: { id: 100 + id, username: `artist${id}` },
});
const [a, b] = [track(1), track(2)];

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function setup() {
  let clock = 1_000_000;
  const storage = memoryStorage();
  const store = createMusicPlayerStore({ now: () => clock });
  const playhead = create<{ currentTime: number }>(() => ({ currentTime: 0 }));
  const stop = persistMusicPlayer({ store, playhead, storage, now: () => clock, intervalMs: 5000 });
  const saved = () => readSavedMusicPlayer(storage);
  return {
    store,
    get: store.getState,
    playhead,
    storage,
    saved,
    stop,
    tick: (seconds: number) => {
      clock += seconds * 1000;
      vi.advanceTimersByTime(seconds * 1000);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saving the song for after a reload', () => {
  it('saves a song when it starts, from its start, without the cover', () => {
    const { get, playhead, saved } = setup();
    playhead.setState({ currentTime: 120 }); // still the previous song's playhead
    get().playTrack({ ...a, cover: { id: 9, url: 'c', hash: null, nsfwLevel: 1 } });
    expect(saved()).toEqual({ track: a, positionSec: 0 });
  });

  it('saves the position on pause', () => {
    const { get, playhead, saved } = setup();
    get().playTrack(a);
    playhead.setState({ currentTime: 3 });
    get().pause();
    expect(saved()?.positionSec).toBe(3);
  });

  it('while the position moves, saves it at most every interval, the latest one last', () => {
    const { get, playhead, saved, tick } = setup();
    get().playTrack(a);
    tick(1);
    playhead.setState({ currentTime: 1 });
    expect(saved()?.positionSec).toBe(0);
    tick(4);
    expect(saved()?.positionSec).toBe(1);
    playhead.setState({ currentTime: 5 });
    playhead.setState({ currentTime: 7 });
    expect(saved()?.positionSec).toBe(1);
    tick(5);
    expect(saved()?.positionSec).toBe(7);
    // Nothing pending and the interval is over: saved at once.
    tick(6);
    playhead.setState({ currentTime: 13 });
    expect(saved()?.positionSec).toBe(13);
  });

  it('a seek while paused is saved', () => {
    const { get, playhead, saved, tick } = setup();
    get().playTrack(a);
    get().pause();
    playhead.setState({ currentTime: 150 });
    tick(5);
    expect(saved()?.positionSec).toBe(150);
  });

  it('saves on page hide', () => {
    vi.stubGlobal('window', new EventTarget());
    const { get, playhead, saved, tick } = setup();
    get().playTrack(a);
    tick(1);
    playhead.setState({ currentTime: 1 });
    window.dispatchEvent(new Event('pagehide'));
    expect(saved()?.positionSec).toBe(1);
  });

  it('closing the player clears it', () => {
    const { get, saved, storage } = setup();
    get().playTrack(a);
    get().close();
    expect(saved()).toBeNull();
    expect(storage.map.has(MUSIC_PLAYER_RESUME_KEY)).toBe(false);
  });

  it('a restored song keeps its saved position', () => {
    const { get, saved } = setup();
    get().restore({ track: b, positionSec: 64 });
    expect(saved()).toEqual({ track: b, positionSec: 64 });
  });

  it('stops saving after cleanup', () => {
    const { get, saved, stop } = setup();
    stop();
    get().playTrack(a);
    expect(saved()).toBeNull();
  });

  it('a storage that throws never breaks the player', () => {
    const store = createMusicPlayerStore();
    const playhead = create<{ currentTime: number }>(() => ({ currentTime: 0 }));
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    persistMusicPlayer({ store, playhead, storage: throwing });
    expect(() => {
      store.getState().playTrack(a);
      store.getState().pause();
      store.getState().close();
    }).not.toThrow();
    expect(readSavedMusicPlayer(throwing)).toBeNull();
  });
});

describe('reading the saved song', () => {
  it('nothing saved → null', () => {
    expect(readSavedMusicPlayer(memoryStorage())).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['wrong shape', JSON.stringify({ track: { id: 'x' }, positionSec: 1 })],
    ['negative position', JSON.stringify({ track: a, positionSec: -1 })],
    ['null', 'null'],
  ])('a corrupt entry (%s) is ignored and removed', (_, raw) => {
    const storage = memoryStorage();
    storage.setItem(MUSIC_PLAYER_RESUME_KEY, raw);
    expect(readSavedMusicPlayer(storage)).toBeNull();
    expect(storage.map.has(MUSIC_PLAYER_RESUME_KEY)).toBe(false);
  });
});

describe('bringing the saved song back on load', () => {
  const image = (overrides: Record<string, unknown> = {}) => ({
    id: a.id,
    type: 'audio',
    url: 'fresh-url.mp3',
    metadata: { title: 'Renamed', duration: 210 },
    user: { id: 101, username: 'artist1-renamed' },
    ...overrides,
  });
  const savedOf = (positionSec = 42) => {
    const storage = memoryStorage();
    storage.setItem(MUSIC_PLAYER_RESUME_KEY, JSON.stringify({ track: a, positionSec }));
    return storage;
  };

  it('a song the viewer can still read comes back paused at its position, with fresh details', async () => {
    const storage = savedOf(42);
    const store = createMusicPlayerStore();
    const fetchSong = vi.fn(async () => image());
    await resumeMusicPlayer({ store, storage, fetchSong });
    expect(fetchSong).toHaveBeenCalledWith(a.id);
    expect(store.getState().current).toMatchObject({
      id: a.id,
      url: 'fresh-url.mp3',
      title: 'Renamed',
      durationSec: 210,
      creator: { id: 101, username: 'artist1-renamed' },
    });
    expect(store.getState().playing).toBe(false);
    expect(store.getState().view).toBe('bar');
    expect(store.getState().playback?.startAtSec).toBe(42);
  });

  it.each([
    [
      'the server refuses it (deleted, private, blocked)',
      async () => {
        throw Object.assign(new Error('not found'), { data: { httpStatus: 404 } });
      },
    ],
    ['its media is withheld from this viewer', async () => image({ url: null })],
    ['it is no longer a song', async () => image({ type: 'image' })],
  ])('dropped silently when %s', async (_, fetchSong) => {
    const storage = savedOf();
    const store = createMusicPlayerStore();
    await resumeMusicPlayer({ store, storage, fetchSong });
    expect(store.getState().current).toBeNull();
    expect(storage.map.has(MUSIC_PLAYER_RESUME_KEY)).toBe(false);
  });

  it('a network failure restores nothing but keeps the saved song for the next load', async () => {
    const storage = savedOf();
    const store = createMusicPlayerStore();
    await resumeMusicPlayer({
      store,
      storage,
      fetchSong: async () => {
        throw new Error('Failed to fetch');
      },
    });
    expect(store.getState().current).toBeNull();
    expect(storage.map.has(MUSIC_PLAYER_RESUME_KEY)).toBe(true);
  });

  it('nothing saved or a corrupt entry: no read, nothing loads', async () => {
    const fetchSong = vi.fn(async () => image());
    const store = createMusicPlayerStore();
    await resumeMusicPlayer({ store, storage: memoryStorage(), fetchSong });
    const corrupt = memoryStorage();
    corrupt.setItem(MUSIC_PLAYER_RESUME_KEY, '{oops');
    await resumeMusicPlayer({ store, storage: corrupt, fetchSong });
    expect(fetchSong).not.toHaveBeenCalled();
    expect(store.getState().current).toBeNull();
  });

  it('a song the listener started meanwhile is kept, and its saved state too', async () => {
    const storage = savedOf();
    const store = createMusicPlayerStore();
    await resumeMusicPlayer({
      store,
      storage,
      fetchSong: async () => {
        store.getState().playTrack(b);
        throw Object.assign(new Error('gone'), { data: { httpStatus: 404 } });
      },
    });
    expect(store.getState().current?.id).toBe(b.id);
    expect(storage.map.has(MUSIC_PLAYER_RESUME_KEY)).toBe(true);
  });
});

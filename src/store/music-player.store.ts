import { create } from 'zustand';

export type MusicTrackCover = { id: number; url: string; hash: string | null; nsfwLevel: number };

export type MusicTrack = {
  /** The song's Image id. */
  id: number;
  /** The stored audio file, as on the Image row. */
  url: string;
  title: string;
  durationSec: number;
  creator: { id: number; username: string };
  cover?: MusicTrackCover | null;
};

export type MusicPlayerView = 'bar' | 'minimized' | 'closed';
export type MusicRepeatMode = 'off' | 'all' | 'one';
export type MusicUpNextSection = 'queued' | 'list';

/** The minimized cover's spot, as fractions of the viewport. */
export type MinimizedPosition = { x: number; y: number };

/**
 * The current playback of the current song, for play counting. `playbackId` changes whenever a
 * song starts from the beginning (a new song, a repeat-one replay, a restart); `listenedSec` is
 * the audio actually played in it: seeking adds nothing and pausing stops the count.
 */
export type MusicPlayback = {
  playbackId: number;
  songId: number;
  durationSec: number;
  listenedSec: number;
};

/**
 * A list a song was started from (a feed, a playlist, a profile's songs, a post): every song in it,
 * in its order, the position of the one that was clicked, and the name Up next shows it under.
 */
export type MusicList = { name: string; tracks: MusicTrack[]; index: number };

type HistoryEntry = { track: MusicTrack; from: MusicUpNextSection };

type PlayerData = {
  current: MusicTrack | null;
  /** The Up next section the current song came from; it goes back there on previous. */
  currentFrom: MusicUpNextSection;
  playing: boolean;
  /** The current song failed to load. */
  error: boolean;
  volume: number;
  muted: boolean;
  /** "Queued by you": songs added with Add to up next / Play next; they play first. */
  queued: MusicTrack[];
  /** "Next from <listName>": the rest of the list play was pressed in. */
  list: MusicTrack[];
  listName: string | null;
  /** Songs played before the current one, oldest first. */
  history: HistoryEntry[];
  /** Where in `history` the sequence started by the last `playTrack` begins (repeat all). */
  sequenceStart: number;
  shuffle: boolean;
  /** Up next in its order before shuffle was turned on. */
  unshuffled: { queued: MusicTrack[]; list: MusicTrack[] } | null;
  repeat: MusicRepeatMode;
  view: MusicPlayerView;
  /** Null: the default spot. */
  minimizedPosition: MinimizedPosition | null;
  playback: MusicPlayback | null;
};

type PlayerActions = {
  /** Plays `track` now. With a `list`, the songs after it in the list become Up next. */
  playTrack: (
    track: MusicTrack,
    options?: { list?: { name: string; tracks: MusicTrack[] } }
  ) => void;
  /**
   * Plays the song at `index` of a list; the songs after it, in list order, become "Next from
   * <name>". The one call any surface that shows songs in a list makes.
   */
  playFromList: (list: MusicList) => void;
  resume: () => void;
  pause: () => void;
  togglePlay: () => void;
  next: () => void;
  /** Restarts the song after 3 s, otherwise goes back to the song played before it. */
  previous: () => void;
  /** The audio reached the end of the current song. */
  ended: () => void;
  addToUpNext: (track: MusicTrack) => void;
  playNext: (track: MusicTrack) => void;
  removeFromUpNext: (id: number) => void;
  clearUpNext: () => void;
  playFromUpNext: (id: number) => void;
  /** Moves a song to `index` of `section`; a queued song cannot move into the list. */
  moveInUpNext: (id: number, section: MusicUpNextSection, index: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  minimize: () => void;
  expand: () => void;
  setMinimizedPosition: (position: MinimizedPosition) => void;
  /** Stops playback and removes every player surface. */
  close: () => void;
  markError: () => void;
  /** The audio element's position, on every `timeupdate`. */
  reportTime: (currentTime: number) => void;
  /** The audio element's own length, once known. */
  reportDuration: (durationSec: number) => void;
};

export type MusicPlayerState = PlayerData & PlayerActions;

const RESTART_THRESHOLD_SEC = 3;
const REPEAT_CYCLE: Record<MusicRepeatMode, MusicRepeatMode> = {
  off: 'all',
  all: 'one',
  one: 'off',
};

const emptySession = {
  current: null,
  currentFrom: 'list',
  playing: false,
  error: false,
  queued: [],
  list: [],
  listName: null,
  history: [],
  sequenceStart: 0,
  unshuffled: null,
  view: 'closed',
  minimizedPosition: null,
  playback: null,
} satisfies Partial<PlayerData>;

const without = (tracks: MusicTrack[], id: number) => tracks.filter((t) => t.id !== id);
const has = (tracks: MusicTrack[], id: number) => tracks.some((t) => t.id === id);
const sectionOf = (s: PlayerData, id: number): MusicUpNextSection | null =>
  has(s.queued, id) ? 'queued' : has(s.list, id) ? 'list' : null;
const sectionPatch = (section: MusicUpNextSection, tracks: MusicTrack[]): Partial<PlayerData> =>
  section === 'queued' ? { queued: tracks } : { list: tracks };

/** `original`'s songs still in `current`, in `original`'s order, then songs added since. */
function restoreOrder(original: MusicTrack[], current: MusicTrack[]) {
  return [
    ...original.filter((t) => has(current, t.id)),
    ...current.filter((t) => !has(original, t.id)),
  ];
}

export function createMusicPlayerStore({
  random = Math.random,
  now = Date.now,
}: { random?: () => number; now?: () => number } = {}) {
  let nextPlaybackId = 1;
  // Position and listen sampling change on every `timeupdate`; nothing renders from them.
  let position = 0;
  let lastSample: { time: number; at: number } | null = null;

  const shuffled = (tracks: MusicTrack[]) => {
    const out = [...tracks];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const newPlayback = (track: MusicTrack): MusicPlayback => {
    position = 0;
    lastSample = null;
    return {
      playbackId: nextPlaybackId++,
      songId: track.id,
      durationSec: track.durationSec,
      listenedSec: 0,
    };
  };

  return create<MusicPlayerState>()((set, get) => {
    /** Makes `track` the current song from its start, the one before it going into history. */
    const switchTo = (track: MusicTrack, from: MusicUpNextSection, patch: Partial<PlayerData>) => {
      const { current, currentFrom, history } = get();
      set({
        history: current ? [...history, { track: current, from: currentFrom }] : history,
        ...patch,
        current: track,
        currentFrom: from,
        playing: true,
        error: false,
        playback: newPlayback(track),
      });
    };

    const restart = (playing: boolean) => {
      const { current } = get();
      if (current) set({ playing, error: false, playback: newPlayback(current) });
    };

    const advance = (auto: boolean) => {
      const s = get();
      if (!s.current) return;
      if (auto && s.repeat === 'one') return restart(true);
      if (s.queued.length) return switchTo(s.queued[0], 'queued', { queued: s.queued.slice(1) });
      if (s.list.length) return switchTo(s.list[0], 'list', { list: s.list.slice(1) });
      if (s.repeat === 'all') {
        const sequence = [...s.history.slice(s.sequenceStart).map((h) => h.track), s.current];
        const rest = sequence.slice(1);
        set({
          history: s.history.slice(0, s.sequenceStart),
          current: sequence[0],
          currentFrom: 'list',
          list: s.shuffle ? shuffled(rest) : rest,
          unshuffled: s.shuffle ? { queued: [], list: rest } : null,
          playing: true,
          error: false,
          playback: newPlayback(sequence[0]),
        });
        return;
      }
      restart(false);
    };

    /** Plays `track` now; the songs `after` it in a list, if any, become the list section. */
    const startFrom = (track: MusicTrack, from: { name: string; after: MusicTrack[] } | null) => {
      const s = get();
      const queued = without(s.queued, track.id);
      const list: MusicTrack[] = [];
      for (const t of from?.after ?? [])
        if (t.id !== track.id && !has(queued, t.id) && !has(list, t.id)) list.push(t);
      const isRestart = s.current?.id === track.id;
      switchTo(track, 'list', {
        queued,
        list: s.shuffle ? shuffled(list) : list,
        listName: from?.name ?? null,
        unshuffled: s.shuffle
          ? { queued: restoreOrder(s.unshuffled?.queued ?? [], queued), list }
          : null,
        view: s.view === 'closed' ? 'bar' : s.view,
      });
      // Playing the current song again restarts it rather than putting it in its own history.
      if (isRestart) set({ history: s.history });
      set({ sequenceStart: get().history.length });
    };

    const loadIfIdle = (track: MusicTrack) => {
      if (get().current) return false;
      set({ current: track, currentFrom: 'list', playing: false, playback: newPlayback(track) });
      if (get().view === 'closed') set({ view: 'bar' });
      return true;
    };

    return {
      ...emptySession,
      volume: 1,
      muted: false,
      shuffle: false,
      repeat: 'off',

      playTrack: (track, options) => {
        if (!options?.list) return startFrom(track, null);
        const { name, tracks } = options.list;
        const index = tracks.findIndex((t) => t.id === track.id);
        startFrom(track, {
          name,
          after: index >= 0 ? tracks.slice(index + 1) : without(tracks, track.id),
        });
      },
      playFromList: ({ name, tracks, index }) => {
        const track = tracks[index];
        if (track) startFrom(track, { name, after: tracks.slice(index + 1) });
      },
      resume: () => {
        if (!get().current) return;
        lastSample = null;
        set({ playing: true, error: false });
      },
      pause: () => {
        lastSample = null;
        set({ playing: false });
      },
      togglePlay: () => (get().playing ? get().pause() : get().resume()),

      next: () => advance(false),
      ended: () => advance(true),
      previous: () => {
        const s = get();
        if (!s.current) return;
        const before = s.history[s.history.length - 1];
        if (position > RESTART_THRESHOLD_SEC || !before) return restart(true);
        const history = s.history.slice(0, -1);
        set({
          ...sectionPatch(s.currentFrom, [s.current, ...s[s.currentFrom]]),
          history,
          sequenceStart: Math.min(s.sequenceStart, history.length),
          current: before.track,
          currentFrom: before.from,
          playing: true,
          error: false,
          playback: newPlayback(before.track),
        });
      },

      addToUpNext: (track) => {
        const s = get();
        if (loadIfIdle(track) || has(s.queued, track.id) || has(s.list, track.id)) return;
        set({ queued: [...s.queued, track] });
      },
      playNext: (track) => {
        const s = get();
        if (loadIfIdle(track) || has(s.queued, track.id) || has(s.list, track.id)) return;
        set({ queued: [track, ...s.queued] });
      },
      removeFromUpNext: (id) => {
        const s = get();
        set({ queued: without(s.queued, id), list: without(s.list, id) });
      },
      clearUpNext: () =>
        set((s) => ({
          queued: [],
          list: [],
          listName: null,
          unshuffled: s.shuffle ? { queued: [], list: [] } : null,
        })),
      playFromUpNext: (id) => {
        const s = get();
        const section = sectionOf(s, id);
        if (!section) return;
        const track = s[section].find((t) => t.id === id) as MusicTrack;
        switchTo(track, section, sectionPatch(section, without(s[section], id)));
      },
      moveInUpNext: (id, section, index) => {
        const s = get();
        const from = sectionOf(s, id);
        if (!from || (from === 'queued' && section === 'list')) return;
        const track = s[from].find((t) => t.id === id) as MusicTrack;
        const lists = {
          queued: s.queued,
          list: s.list,
          ...sectionPatch(from, without(s[from], id)),
        };
        const target = [...(lists[section] ?? [])];
        target.splice(Math.max(0, Math.min(target.length, index)), 0, track);
        set({ ...lists, ...sectionPatch(section, target) });
      },

      toggleShuffle: () =>
        set((s) =>
          s.shuffle
            ? {
                shuffle: false,
                queued: restoreOrder(s.unshuffled?.queued ?? [], s.queued),
                list: restoreOrder(s.unshuffled?.list ?? [], s.list),
                unshuffled: null,
              }
            : {
                shuffle: true,
                unshuffled: { queued: s.queued, list: s.list },
                queued: shuffled(s.queued),
                list: shuffled(s.list),
              }
        ),
      cycleRepeat: () => set((s) => ({ repeat: REPEAT_CYCLE[s.repeat] })),

      setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
      toggleMute: () => set((s) => ({ muted: !s.muted })),

      minimize: () => set((s) => (s.view === 'bar' ? { view: 'minimized' } : {})),
      expand: () => set((s) => (s.view === 'minimized' ? { view: 'bar' } : {})),
      setMinimizedPosition: (minimizedPosition) => set({ minimizedPosition }),

      close: () => {
        position = 0;
        lastSample = null;
        set(emptySession);
      },
      markError: () => set({ error: true, playing: false }),

      reportTime: (currentTime) => {
        position = currentTime;
        const { playing, playback } = get();
        if (!playing || !playback) {
          lastSample = null;
          return;
        }
        const at = now();
        const sample = lastSample;
        lastSample = { time: currentTime, at };
        if (!sample) return;
        // Media time counts only as fast as the clock runs, so a forward seek adds nothing.
        const played = Math.min(currentTime - sample.time, (at - sample.at) / 1000);
        if (played > 0)
          set({ playback: { ...playback, listenedSec: playback.listenedSec + played } });
      },
      reportDuration: (durationSec) => {
        const { playback } = get();
        if (playback && isFinite(durationSec) && durationSec > 0)
          set({ playback: { ...playback, durationSec } });
      },
    };
  });
}

/** The global player's state. Exactly one `<audio>` element plays it: `MusicPlayerAudio`. */
export const useMusicPlayerStore = createMusicPlayerStore();

/**
 * The playhead, kept apart from the player store because it changes on every `timeupdate`: only
 * the components that show the time subscribe to it.
 */
export const useMusicPlayheadStore = create<{ currentTime: number; duration: number }>(() => ({
  currentTime: 0,
  duration: 0,
}));

/** True while a player surface shows (the bar or the minimized cover): the bottom ads stand down. */
export const useMusicPlayerActive = () => useMusicPlayerStore((s) => s.view !== 'closed');

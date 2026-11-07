/**
 * The game's quiet sounds. Nothing plays until the player has interacted with the page, a muted player hears nothing,
 * and no failure (blocked autoplay, missing file, no storage) ever reaches the caller. Files live in static/sounds as
 * .ogg and .mp3; the browser's own support picks one.
 */

export const SOUND_NAMES = [
  'press',
  'trial-correct',
  'trial-wrong',
  'gold',
  'bell',
  'rankup',
  'knighting-ring',
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];
export type SoundFormat = 'ogg' | 'mp3';

export const MASTER_VOLUME = 0.5;
/** Each sound's level before the master volume; the answer press is the quietest by far (about 0.18 once mastered). */
export const SOUND_LEVELS: Record<SoundName, number> = {
  press: 0.36,
  'trial-correct': 0.8,
  'trial-wrong': 0.8,
  gold: 0.7,
  bell: 0.8,
  rankup: 0.8,
  'knighting-ring': 0.8,
};
export const PRESS_DEBOUNCE_MS = 60;

const MIME: Record<SoundFormat, string> = { ogg: 'audio/ogg; codecs="vorbis"', mp3: 'audio/mpeg' };

export function pickFormat(canPlayType: (mime: string) => string): SoundFormat | null {
  for (const format of ['ogg', 'mp3'] as const) if (canPlayType(MIME[format])) return format;
  return null;
}

type Store = Pick<Storage, 'getItem'>;
type WritableStore = Store & Pick<Storage, 'setItem'>;

export const mutedKey = (playerId: number | string | null) =>
  `knights:sound-muted:${playerId ?? 'anon'}`;

export function readMuted(storage: Store | null, playerId: number | string | null): boolean {
  try {
    return storage?.getItem(mutedKey(playerId)) === '1';
  } catch {
    return false;
  }
}

export function writeMuted(
  storage: WritableStore | null,
  playerId: number | string | null,
  muted: boolean
) {
  try {
    storage?.setItem(mutedKey(playerId), muted ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the choice just lasts until the page closes.
  }
}

export type AudioLike = {
  volume: number;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  preload: string;
  play(): Promise<void> | void;
};

type Deps = {
  createAudio: (src: string) => AudioLike;
  format: () => SoundFormat | null;
  storage: () => WritableStore | null;
  now: () => number;
  basePath?: string;
};

export function createSoundEngine(deps: Deps) {
  const basePath = deps.basePath ?? '/sounds';
  const cache = new Map<SoundName, AudioLike>();
  let unlocked = false;
  let playerId: number | string | null = null;
  let muted = false;
  let lastPress = Number.NEGATIVE_INFINITY;

  const guard = <T>(work: () => T, fallback: T): T => {
    try {
      return work();
    } catch {
      return fallback;
    }
  };

  const sourceOf = (name: SoundName) => {
    const format = deps.format();
    return format ? `${basePath}/${name}.${format}` : null;
  };

  function load(name: SoundName) {
    let audio = cache.get(name);
    if (!audio) {
      const src = sourceOf(name);
      if (!src) return null;
      audio = deps.createAudio(src);
      audio.preload = 'auto';
      cache.set(name, audio);
    }
    return audio;
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    // The files are tiny; fetch them once the page is interactive so the first play has nothing to wait for.
    for (const name of SOUND_NAMES) guard(() => load(name), null);
  }

  return {
    get muted() {
      return muted;
    },
    get unlocked() {
      return unlocked;
    },
    /** Switches to a player's stored choice; call when the signed-in player is known. */
    setPlayer(id: number | string | null) {
      playerId = id;
      muted = guard(() => readMuted(deps.storage(), id), false);
    },
    setMuted(next: boolean) {
      muted = next;
      guard(() => writeMuted(deps.storage(), playerId, next), undefined);
    },
    unlock,
    /** The first pointer, key or touch on the target opens the gate. */
    attach(target: EventTarget) {
      const events = ['pointerdown', 'keydown', 'touchstart'];
      const open = () => {
        unlock();
        for (const event of events) target.removeEventListener(event, open);
      };
      for (const event of events) target.addEventListener(event, open, { passive: true });
    },
    play(name: SoundName) {
      guard(() => {
        if (!unlocked || muted) return;
        if (name === 'press') {
          const now = deps.now();
          if (now - lastPress < PRESS_DEBOUNCE_MS) return;
          lastPress = now;
        }
        const base = load(name);
        if (!base) return;
        // A sound still playing is left alone and a second copy plays over it.
        const voice = base.paused || base.ended ? base : deps.createAudio(sourceOf(name) as string);
        voice.volume = SOUND_LEVELS[name] * MASTER_VOLUME;
        voice.currentTime = 0;
        const started = voice.play();
        if (started && typeof started.catch === 'function') started.catch(() => undefined);
      }, undefined);
    },
  };
}

export type SoundEngine = ReturnType<typeof createSoundEngine>;

/** The page's one engine. Built from browser globals only when used, so importing it on the server is harmless. */
export const sound = createSoundEngine({
  createAudio: (src) => new Audio(src),
  format: () => pickFormat((mime) => document.createElement('audio').canPlayType(mime)),
  storage: () => window.localStorage,
  now: () => Date.now(),
});

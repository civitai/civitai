/**
 * The song player every moderator song card shares: nothing plays until a moderator asks, one song
 * plays at a time, and each song starts at the last volume chosen (kept in this browser).
 *
 * Each card owns its `<audio>` element and registers it here; the card forwards the element's `play`
 * and `volumechange` events. `playSongAt` is how anything else on the page (a report's time chip)
 * starts a card's song at a given time.
 */

/** What the player reads and drives of an `<audio>` element. */
export type SongMedia = {
  play(): Promise<void> | void;
  pause(): void;
  currentTime: number;
  volume: number;
  readonly paused: boolean;
};

export type VolumeStore = { read(): number | null; write(volume: number): void };

/** Which card a song is on, where the same song shows twice (one card per report). */
export type SongCardKey = string | number;

type Entry = { media: SongMedia; cardKey?: SongCardKey };

export function createSongPlayer(store: VolumeStore) {
  const cards = new Map<number, Entry[]>();
  let current: SongMedia | null = null;

  /** Pauses whichever other song is playing. Call from the element's `play` event. */
  function played(media: SongMedia) {
    if (current && current !== media && !current.paused) current.pause();
    current = media;
  }

  return {
    /** A card's element, which takes the last volume and is never started here. Returns the
     *  cleanup, which stops the song: a card that leaves the page takes its sound with it. */
    register(imageId: number, media: SongMedia, cardKey?: SongCardKey): () => void {
      const volume = store.read();
      if (volume != null) media.volume = volume;
      cards.set(imageId, [...(cards.get(imageId) ?? []), { media, cardKey }]);
      return () => {
        media.pause();
        if (current === media) current = null;
        const rest = (cards.get(imageId) ?? []).filter((entry) => entry.media !== media);
        if (rest.length) cards.set(imageId, rest);
        else cards.delete(imageId);
      };
    },
    played,
    /** Remembers the volume for the next song. Call from the element's `volumechange` event. */
    volumeChanged(media: SongMedia) {
      store.write(media.volume);
    },
    /**
     * Starts song `imageId` at `seconds` on the card `cardKey` names, else on a card showing it: the
     * one already playing it, else the first. False when no card on the page shows that song.
     */
    playAt(imageId: number, seconds: number, cardKey?: SongCardKey): boolean {
      const shown = cards.get(imageId) ?? [];
      const media = (
        shown.find((entry) => cardKey != null && entry.cardKey === cardKey) ??
        shown.find((entry) => entry.media === current) ??
        shown[0]
      )?.media;
      if (!media) return false;
      media.currentTime = Math.max(0, seconds);
      played(media);
      // A refused play (the file failed) is the card's to show, through the element's own events.
      void Promise.resolve(media.play()).catch(() => undefined);
      return true;
    },
  };
}

const VOLUME_KEY = 'moderator:song-volume';

/** The volume in this browser's localStorage; nothing on the server or where storage is refused. */
const localVolume: VolumeStore = {
  read() {
    try {
      const raw = globalThis.localStorage?.getItem(VOLUME_KEY);
      const volume = raw == null ? NaN : Number(raw);
      return volume >= 0 && volume <= 1 ? volume : null;
    } catch {
      return null;
    }
  },
  write(volume) {
    try {
      globalThis.localStorage?.setItem(VOLUME_KEY, String(volume));
    } catch {
      // Private mode or a full quota: the volume just is not remembered.
    }
  },
};

export const songPlayer = createSongPlayer(localVolume);

/**
 * Plays song `imageId` from `seconds` on its card on this page, pausing any other song. Pass the
 * card's `cardKey` (the grid's item key, e.g. a report id) where the same song can show on more than
 * one card. Returns false when no card on the page shows that song.
 */
export const playSongAt = (imageId: number, seconds: number, cardKey?: SongCardKey) =>
  songPlayer.playAt(imageId, seconds, cardKey);

/** `m:ss`, and 0:00 for a time not known yet. */
export function formatSongTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

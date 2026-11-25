/**
 * The song player every moderator song card shares: nothing plays until a moderator asks, one song
 * plays at a time, and each song starts at the last volume chosen (kept in this browser).
 *
 * Each card owns its `<audio>` element and registers it here; the card forwards the element's `play`
 * and `volumechange` events. `playSongAt` is how anything else on the page (a report's time chip)
 * starts a card's song at a given time.
 */

import { formatPlaybackTime } from '@civitai/shared';

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

/** What a card answers when something outside it starts its song at a time (a report's time chip):
 *  false refuses (the card's file failed, nothing to play); true records that play was asked for. */
export type SongCardHook = { wantPlay(at: number): boolean };

type Entry = { media: SongMedia; cardKey?: SongCardKey; card?: SongCardHook };

// Closer than this to the playhead, a seek-bar value is the bar echoing the playhead back.
const SEEK_TOLERANCE_SEC = 0.5;

/** Whether the seek bar's value is a move by the moderator rather than the bar following the song. */
export const isSeek = (target: number, current: number) =>
  Math.abs(target - current) >= SEEK_TOLERANCE_SEC;

/** The `<audio>` events that start or end a load. */
export type SongLoadEvent = 'play' | 'waiting' | 'playing' | 'canplay' | 'pause' | 'error';

/**
 * Whether a card's song is loading after `event`: from a play until it can play, and while it waits
 * for data. A removed song from storage loads only once played, so without this the button would
 * read Pause over a silent 0:00.
 */
export function songLoading(loading: boolean, event: SongLoadEvent): boolean {
  if (event === 'play' || event === 'waiting') return true;
  if (event === 'playing' || event === 'canplay' || event === 'pause' || event === 'error')
    return false;
  return loading;
}

let keySeq = 0;
/** A key of its own for a card no caller named, so its controls drive that card and no other
 *  showing the same song. */
export const uniqueCardKey = (): SongCardKey => `song-card-${++keySeq}`;

/**
 * Whether a card's song goes on playing when its source is swapped (the CDN refused it, storage is
 * next): only when the moderator asked for play and has not paused it since.
 */
export function createPlayIntent() {
  let wanted = false;
  let startAt: number | null = null;
  return {
    /** The play button, or a time to play from (a lyric line, a report's time or marker). */
    requested(at?: number) {
      wanted = true;
      startAt = at ?? null;
    },
    /** The element's `playing` event: from here a swap goes on from wherever the song is. */
    started() {
      startAt = null;
    },
    /** The element's `pause` event, which `ended` fires too. */
    paused() {
      wanted = false;
      startAt = null;
    },
    /** Read before the swap: removing the old element pauses it. */
    resumeAfterSwap: () => wanted,
    /** The time play was asked from, when the song has not started yet: the stored copy starts there. */
    resumeAt: () => startAt,
  };
}

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
    register(
      imageId: number,
      media: SongMedia,
      cardKey?: SongCardKey,
      card?: SongCardHook
    ): () => void {
      const volume = store.read();
      if (volume != null) media.volume = volume;
      cards.set(imageId, [...(cards.get(imageId) ?? []), { media, cardKey, card }]);
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
    playAt(imageId: number, seconds: number, cardKey?: SongCardKey): boolean {
      const shown = cards.get(imageId) ?? [];
      const entry =
        shown.find((e) => cardKey != null && e.cardKey === cardKey) ??
        shown.find((e) => e.media === current) ??
        shown[0];
      if (!entry || (entry.card && !entry.card.wantPlay(Math.max(0, seconds)))) return false;
      const { media } = entry;
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

/** The lyric line playing at `timeSec`: the last timed line that has started (`t` in ms), or -1. A
 *  line without a time is never the playing one. */
export function playingLyricIndex<L extends { t: number | null }>(
  lines: readonly L[],
  timeSec: number
): number {
  const ms = timeSec * 1000;
  let playing = -1;
  lines.forEach((line, i) => {
    if (line.t != null && line.t <= ms && (playing === -1 || line.t >= lines[playing].t!))
      playing = i;
  });
  return playing;
}

/** A report's mark on a song's seek bar: where it sits (0 to 100) and its hover text. */
export type SeekMarker = { timeSec: number; percent: number; title: string };

// A report filed at the upload's stored length stays on the bar when the file reads a little
// shorter; the main app refuses anything further.
const END_SLACK_SEC = 1;

/** Reports in the same second share one marker. A report without a time, or past the song's end
 *  plus END_SLACK_SEC, draws nothing; nothing is drawn until the length is known. */
export function seekMarkers(
  reports: readonly { timeSec: number | null; label: string }[],
  durationSec: number
): SeekMarker[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const bySecond = new Map<number, { timeSec: number; labels: Set<string> }>();
  const timed = reports
    .filter((r): r is { timeSec: number; label: string } => r.timeSec != null)
    .filter((r) => r.timeSec >= 0 && r.timeSec <= durationSec + END_SLACK_SEC)
    .sort((a, b) => a.timeSec - b.timeSec);
  for (const r of timed) {
    const second = Math.floor(r.timeSec);
    const mark = bySecond.get(second) ?? { timeSec: r.timeSec, labels: new Set<string>() };
    mark.labels.add(r.label);
    bySecond.set(second, mark);
  }
  return [...bySecond.values()].map(({ timeSec, labels }) => ({
    timeSec,
    percent: (Math.min(timeSec, durationSec) / durationSec) * 100,
    title: `Report at ${formatPlaybackTime(timeSec)}: ${[...labels].join(' · ')}`,
  }));
}

/** A marker's label above the bar: its text, or null when it would collide, and where it sits in
 *  px from the bar's left. */
export type MarkerLabel = { timeSec: number; text: string | null; left: number; width: number };

// The labels are 11px semibold; a fixed per-character width keeps the layout decidable without
// measuring text.
const LABEL_CHAR_PX = 6.5;
const LABEL_GAP_PX = 4;

/** The first marker reads "Report at m:ss", the rest their time, each centred on its marker and
 *  kept inside the bar. The first shortens to its time when the long text reaches the next label;
 *  a label that still overlaps the last one shown is hidden (the marker keeps its hover title). */
export function markerLabels(markers: readonly SeekMarker[], barWidthPx: number): MarkerLabel[] {
  const place = (mark: SeekMarker, text: string) => {
    const width = text.length * LABEL_CHAR_PX;
    const centre = (mark.percent / 100) * barWidthPx;
    const left = Math.min(Math.max(centre - width / 2, 0), Math.max(barWidthPx - width, 0));
    return { timeSec: mark.timeSec, text, left, width };
  };
  const overlaps = (a: MarkerLabel, b: MarkerLabel) => a.left + a.width + LABEL_GAP_PX > b.left;
  if (!(barWidthPx > 0)) return markers.map((m) => ({ ...place(m, ''), text: null }));
  const labels = markers.map((m) => place(m, formatPlaybackTime(m.timeSec)));
  if (labels.length) {
    const long = place(markers[0], `Report at ${formatPlaybackTime(markers[0].timeSec)}`);
    if (labels.length === 1 || !overlaps(long, labels[1])) labels[0] = long;
  }
  let shown: MarkerLabel | null = null;
  return labels.map((label) => {
    if (shown && overlaps(shown, label)) return { ...label, text: null };
    shown = label;
    return label;
  });
}

/** The first reported time after the playhead, past the one it was just sent to; null after the
 *  last, which disables "Next report". */
export function nextReportTime(markers: readonly SeekMarker[], currentSec: number): number | null {
  return (
    markers.find((m) => isSeek(m.timeSec, currentSec) && m.timeSec > currentSec)?.timeSec ?? null
  );
}

/** A section heading of the lyrics (`[Chorus]`): shown, never played from or reported on. */
export const isLyricSection = (text: string) => /^\s*\[[^\]]+\]\s*$/.test(text);

/**
 * Per lyric line (by index), the reports whose time falls in its span: from its time to the next
 * timed line's (the last runs to the end). A report counts its merged reporters too. Untimed lines
 * and section headings have no span; a report before the first line is on none.
 */
export function reportedLyricCounts(
  lines: readonly { t: number | null; text: string }[],
  reports: readonly { timeSec: number | null; also?: number }[]
): Map<number, number> {
  const spans = lines
    .map((line, index) => ({ index, t: line.t, text: line.text }))
    .filter(
      (l): l is { index: number; t: number; text: string } => l.t != null && !isLyricSection(l.text)
    )
    .sort((a, b) => a.t - b.t);
  const counts = new Map<number, number>();
  for (const report of reports) {
    if (report.timeSec == null) continue;
    const ms = report.timeSec * 1000;
    let line: number | null = null;
    for (const span of spans) if (span.t <= ms) line = span.index;
    if (line != null) counts.set(line, (counts.get(line) ?? 0) + 1 + (report.also ?? 0));
  }
  return new Map([...counts].sort((a, b) => a[0] - b[0]));
}

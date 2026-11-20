import * as z from 'zod';
import type { StoreApi } from 'zustand';
import type { MusicPlayerState, MusicTrack } from '~/store/music-player.store';

/** The last song the global player had loaded, kept so a reload brings the bar back paused. */
export const MUSIC_PLAYER_RESUME_KEY = 'music-player:resume';
/** While a song plays, its position is saved at most this often. */
export const MUSIC_PLAYER_RESUME_INTERVAL_MS = 5000;

const savedSchema = z.object({
  track: z.object({
    id: z.number().int().positive(),
    url: z.string().min(1),
    title: z.string(),
    durationSec: z.number().nonnegative(),
    creator: z.object({ id: z.number().int(), username: z.string() }),
  }),
  positionSec: z.number().nonnegative(),
});

export type SavedMusicPlayer = { track: MusicTrack; positionSec: number };

type ResumeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): ResumeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage blocked (private window, site data off).
    return null;
  }
}

export function clearSavedMusicPlayer(storage = defaultStorage()) {
  try {
    storage?.removeItem(MUSIC_PLAYER_RESUME_KEY);
  } catch {}
}

/** The saved song and position, or null when there is none or it cannot be read. */
export function readSavedMusicPlayer(storage = defaultStorage()): SavedMusicPlayer | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(MUSIC_PLAYER_RESUME_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    const parsed = savedSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  clearSavedMusicPlayer(storage);
  return null;
}

function writeSavedMusicPlayer(saved: SavedMusicPlayer, storage: ResumeStorage | null) {
  // The cover is re-read with the viewer's own rules when the bar renders; it is not kept.
  const { id, url, title, durationSec, creator } = saved.track;
  const value: SavedMusicPlayer = {
    track: { id, url, title, durationSec, creator: { id: creator.id, username: creator.username } },
    positionSec: Math.max(0, saved.positionSec),
  };
  try {
    storage?.setItem(MUSIC_PLAYER_RESUME_KEY, JSON.stringify(value));
  } catch {}
}

/**
 * Keeps the saved song in step with the player: saved when a song starts, on pause, on page hide
 * and at most every `intervalMs` while the position moves (playing or seeking); cleared when the
 * player is closed. Returns the cleanup.
 */
export function persistMusicPlayer({
  store,
  playhead,
  storage = defaultStorage(),
  now = Date.now,
  intervalMs = MUSIC_PLAYER_RESUME_INTERVAL_MS,
}: {
  store: Pick<StoreApi<MusicPlayerState>, 'getState' | 'subscribe'>;
  playhead: Pick<StoreApi<{ currentTime: number }>, 'getState' | 'subscribe'>;
  storage?: ResumeStorage | null;
  now?: () => number;
  intervalMs?: number;
}) {
  let lastSaveAt = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;

  const save = (positionSec = playhead.getState().currentTime) => {
    clearTimeout(trailing);
    trailing = undefined;
    const { current } = store.getState();
    if (!current) return;
    lastSaveAt = now();
    writeSavedMusicPlayer({ track: current, positionSec }, storage);
  };

  const unsubscribeStore = store.subscribe((state, prev) => {
    if (!state.current) {
      if (prev.current) {
        clearTimeout(trailing);
        clearSavedMusicPlayer(storage);
      }
      return;
    }
    // A new playback starts where the store says; the playhead may still show the previous song.
    if (state.playback?.playbackId !== prev.playback?.playbackId)
      return save(state.playback?.startAtSec ?? 0);
    if (state.playing !== prev.playing) save();
  });

  const unsubscribePlayhead = playhead.subscribe(() => {
    if (!store.getState().current) return;
    const wait = lastSaveAt + intervalMs - now();
    if (wait <= 0) return save();
    if (trailing === undefined) trailing = setTimeout(() => save(), wait);
  });

  const onPageHide = () => save();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return () => {
    clearTimeout(trailing);
    unsubscribeStore();
    unsubscribePlayhead();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
  };
}

/** The fields of an `image.get` answer the resume needs. */
export type ResumableSongImage = {
  type: string;
  url: string | null;
  metadata?: unknown;
  user: { id: number; username?: string | null };
};

/** The saved track with the song's current details, or null when it may no longer play. */
function resumableTrack(image: ResumableSongImage, saved: MusicTrack): MusicTrack | null {
  if (image.type !== 'audio' || !image.url) return null;
  const metadata = (image.metadata ?? {}) as { title?: string; duration?: number };
  return {
    id: saved.id,
    url: image.url,
    title: metadata.title ?? saved.title,
    durationSec: metadata.duration ?? saved.durationSec,
    creator: { id: image.user.id, username: image.user.username ?? '' },
  };
}

/** A tRPC error the server answered (4xx), as opposed to a request that never got an answer. */
const isRefusal = (error: unknown) => {
  const status = (error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;
  return !!status && status >= 400 && status < 500;
};

/**
 * Loads the saved song paused at its position, after re-reading it as this viewer (it may have been
 * deleted, blocked or made private since). A song the viewer can no longer play is dropped
 * silently; a failed request keeps it for the next load. Never starts playback.
 */
export async function resumeMusicPlayer({
  store,
  fetchSong,
  storage = defaultStorage(),
}: {
  store: Pick<StoreApi<MusicPlayerState>, 'getState'>;
  fetchSong: (id: number) => Promise<ResumableSongImage>;
  storage?: ResumeStorage | null;
}) {
  const saved = readSavedMusicPlayer(storage);
  if (!saved) return;
  let track: MusicTrack | null = null;
  try {
    track = resumableTrack(await fetchSong(saved.track.id), saved.track);
  } catch (error) {
    if (!isRefusal(error)) return;
  }
  // The listener started a song meanwhile: that one stays, and so does its saved state.
  if (store.getState().current) return;
  if (track) store.getState().restore({ track, positionSec: saved.positionSec });
  else clearSavedMusicPlayer(storage);
}

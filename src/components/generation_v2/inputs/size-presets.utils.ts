import { MAX_SIZE_PRESETS } from '~/server/schema/generation-size-preset.schema';

type SavedSize = { id: number; width: number; height: number };

/**
 * The cached list after a save, as the server now has it: the saved size first
 * (newest first), once, and — past the cap — the oldest dropped, the same one the
 * server deleted.
 */
export function withSavedSize<T extends SavedSize>(all: T[], saved: T): T[] {
  return [saved, ...all.filter((p) => p.id !== saved.id)].slice(0, MAX_SIZE_PRESETS);
}

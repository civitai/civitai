type WatchStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The oldest clips drop off past this, so a judge's store stays small. */
export const WATCH_MEMORY_LIMIT = 300;

export const watchMemoryKey = (userId: number, crucibleId: number) =>
  `crucible-watch:${userId}:${crucibleId}`;

/** Oldest first, so the cap drops the clips watched longest ago. */
type Stored = [entryId: number, ms: number][];

export function browserStorage(): WatchStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function read(storage: WatchStorage | undefined, key: string): Stored {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (pair): pair is Stored[number] =>
        Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1])
    );
  } catch {
    return [];
  }
}

export function readWatchedMs(storage: WatchStorage | undefined, key: string, entryId: number) {
  return read(storage, key).find(([id]) => id === entryId)?.[1] ?? 0;
}

/** Keeps the most watched so far; a smaller value changes nothing. */
export function rememberWatchedMs(
  storage: WatchStorage | undefined,
  key: string,
  entryId: number,
  ms: number
) {
  const stored = read(storage, key);
  if (ms <= (stored.find(([id]) => id === entryId)?.[1] ?? 0)) return;
  const next: Stored = [...stored.filter(([id]) => id !== entryId), [entryId, ms]];
  try {
    storage?.setItem(key, JSON.stringify(next.slice(-WATCH_MEMORY_LIMIT)));
  } catch {
    // Private mode or a full store: the clip just needs watching again next visit.
  }
}

import { sendInBackground, type SeenStorage } from './seen-marker';
import type { UpdateEntry } from './whats-new';

/** The layout's "What's new" data: the entries for the player's rank, newest first, and how many they have not seen. */
export type Updates = { entries: UpdateEntry[]; unseen: number };

export type UpdatesDeps = {
  userId: number | null;
  /** May throw: some browsers refuse `localStorage` itself, not only its methods. */
  storage: () => SeenStorage;
  /** Records the entries as seen on the server; true once it is stored. */
  send: () => Promise<boolean>;
  /** Re-reads the layout, so the server's count agrees. */
  refresh: () => unknown;
};

/**
 * `seen` is the newest entry this browser closed the dialog on; `autoOpened` keeps it to one automatic showing per load, and
 * `resent` to one repeat of the server write (a deploy in progress can answer from an older build, which would loop).
 */
export type UpdatesState = {
  open: boolean;
  seen: string | null;
  autoOpened: boolean;
  resent?: boolean;
};

const latestOf = (updates: Updates | null) => updates?.entries[0]?.id ?? null;
const seenKey = (userId: number) => `knights:whats-new-entry:${userId}`;

function readSeen({ userId, storage }: UpdatesDeps): string | null {
  if (userId === null) return null;
  try {
    return storage().getItem(seenKey(userId));
  } catch {
    return null;
  }
}

function writeSeen({ userId, storage }: UpdatesDeps, id: string) {
  if (userId === null) return;
  try {
    storage().setItem(seenKey(userId), id);
  } catch {
    // Without storage the server's record is the only one; the dot comes back on the next load if the send failed.
  }
}

/** The entries still unseen here: none once this browser closed the dialog on the newest one, whatever the server says yet. */
export function unseenNow(updates: Updates | null, state: UpdatesState): number {
  if (!updates || updates.unseen === 0) return 0;
  return state.seen !== null && state.seen === latestOf(updates) ? 0 : updates.unseen;
}

/**
 * Runs whenever the layout's data changes. A browser that already closed the dialog on the newest entry sends that again
 * instead of showing it (the earlier send may have failed); otherwise unseen entries open the dialog once, where allowed.
 */
export function syncUpdates(
  state: UpdatesState,
  updates: Updates | null,
  deps: UpdatesDeps,
  autoOpen: boolean
) {
  const latest = latestOf(updates);
  if (!updates || updates.unseen === 0 || latest === null) return;
  if (readSeen(deps) === latest) {
    state.seen = latest;
    if (!state.resent) {
      state.resent = true;
      sendInBackground(deps);
    }
    return;
  }
  if (autoOpen && !state.autoOpened && unseenNow(updates, state) > 0) {
    state.autoOpened = true;
    state.open = true;
  }
}

/** Got it, Escape and the backdrop: closed at once; unseen entries are remembered here and recorded on the server. */
export function closeUpdates(state: UpdatesState, updates: Updates | null, deps: UpdatesDeps) {
  state.open = false;
  const latest = latestOf(updates);
  if (latest === null || unseenNow(updates, state) === 0) return;
  state.seen = latest;
  writeSeen(deps, latest);
  sendInBackground(deps);
}

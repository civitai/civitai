/**
 * The submissions a moderator SKIPPED on the review page in this browser session — so "next"
 * stops offering them.
 *
 * 🔴 WHY IT EXISTS AT ALL. "Next" is the OLDEST pending submission (`nextPendingRequestId`), and
 * a skipped submission is still pending and still the oldest. Without this list, Skip on the
 * oldest one opened the second, and the next decision there went straight back to the first.
 *
 * 🔴 CLIENT-SIDE ONLY. Nothing here is sent anywhere: a skip is not a decision, so no server
 * state records it. The list lives in `sessionStorage` (one tab's session) with an in-memory
 * copy for when storage is unavailable or throws (private mode, a quota, a sandboxed frame).
 * It is cleared by the moderator ("Review skipped") or when the queue runs out.
 */

const STORAGE_KEY = 'apps-review-skipped';

let memory: string[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function load(): string[] {
  if (loaded) return memory;
  loaded = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    memory = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    memory = [];
  }
  return memory;
}

function save(next: string[]) {
  memory = next;
  loaded = true;
  try {
    const s = storage();
    if (next.length === 0) s?.removeItem(STORAGE_KEY);
    else s?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the in-memory copy still holds for this page's lifetime.
  }
  listeners.forEach((l) => l());
}

export const reviewSkipList = {
  /** The skipped ids, oldest skip first. Stable identity until the list changes. */
  get(): readonly string[] {
    return load();
  },
  add(id: string) {
    const current = load();
    if (current.includes(id)) return;
    save([...current, id]);
  },
  clear() {
    if (load().length === 0) return;
    save([]);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Tests only: forget the in-memory copy so the next read goes back to storage. */
  resetForTests() {
    memory = [];
    loaded = false;
  },
};

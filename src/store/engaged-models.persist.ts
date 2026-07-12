import type { EngagedModelsByIdsResult, EngagedModelType } from '~/store/engaged-models.store';
import { useEngagedModelsStore } from '~/store/engaged-models.store';

/**
 * Cross-page-load persistence for the engaged-models membership store.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `useEngagedModelsStore` zustand store is a module-level singleton, so it
 * survives SPA soft-navigation IN MEMORY — an id queried once is never
 * re-requested for the life of the JS context (the batcher skips ids already in
 * `queried`). But it is memory-ONLY: every FRESH JS context (hard reload, a new
 * tab, a returning session) boots with an empty `queried` set, so all model ids
 * currently on screen get re-queried via `user.getEngagedModelsByIds`. That
 * per-page-load re-query — not within-page bursts — is the driver behind
 * `getEngagedModelsByIds` sitting at a frequency-invariant ~13-14% of all API
 * req/s. A prior within-page client debounce (#3074) was a measured null for
 * exactly this reason.
 *
 * WHAT THIS DOES
 * --------------
 * Persist the store's membership + known-id set to `localStorage`, keyed by the
 * current userId, with a per-id freshness timestamp. On the next load we
 * rehydrate only the ids that are (a) this user's and (b) still fresh (within a
 * short TTL); the batcher then skips those and only queries ids it does NOT
 * already know-and-fresh.
 *
 * STORAGE CHOICE — localStorage (not sessionStorage).
 *   The re-query is dominated by fresh JS contexts: hard reloads, NEW TABS, and
 *   returning sessions. sessionStorage is per-tab and dies with the tab, so it
 *   would miss new-tab and cross-session returns — the bulk of the load.
 *   localStorage survives across tabs and sessions, cutting all of them. The
 *   extra staleness that buys (a cross-tab/device engagement change not being in
 *   the persisted blob) is bounded by the TTL below.
 *
 * TTL — 5 minutes per id.
 *   Engagement state (favorite / hide / notify / review) changes rarely relative
 *   to a browsing session, so a 5-minute freshness bound eliminates the re-query
 *   for the common rapid-return pattern (reload, back/forward, open-in-new-tab)
 *   while capping the staleness window: after TTL an id is treated as unknown and
 *   re-queried, refreshing it. Optimistic writes in the ACTIVE tab still write
 *   through the store (and re-stamp the id fresh), so the acting tab is never
 *   stale. RESIDUAL RISK, explicit: a returning tab can briefly show stale
 *   favorite/HIDDEN state for a model the user changed in ANOTHER tab/device —
 *   e.g. a model hidden elsewhere re-appearing — for at most TTL, until the id is
 *   re-queried. The TTL is deliberately short to bound that window.
 *
 * PER-USER ISOLATION — the blob carries its userId; a blob whose userId does not
 *   match the current user is IGNORED (and cleared), so user A's favorited/hidden
 *   state is never shown to user B on a shared browser. A user change resets the
 *   in-memory store before rehydrating the new user.
 *
 * SSR / STORAGE-UNAVAILABLE SAFETY — every storage access is guarded by
 *   `typeof window` + try/catch. Rehydration runs only from a client effect
 *   (post-mount), so the server render and first client paint both see the empty
 *   store (no hydration mismatch); the persisted state is folded in afterwards.
 *   If storage is missing or throws (SSR, private mode, quota, disabled) the
 *   store silently falls back to today's memory-only behavior — it NEVER throws.
 *
 * SIZE CAP — at most `maxIds` ids are persisted; the oldest (by timestamp) are
 *   evicted so the blob can't grow unbounded on a heavy browser.
 */

export const ENGAGED_PERSIST_STORAGE_KEY = 'engaged-models-persist-v1';
export const ENGAGED_PERSIST_SCHEMA_VERSION = 1;

interface PersistConfig {
  ttlMs: number;
  maxIds: number;
  /** Debounce before a store change is written back to storage. */
  debounceMs: number;
}

const config: PersistConfig = {
  ttlMs: 5 * 60 * 1000,
  maxIds: 3000,
  debounceMs: 500,
};

/** One persisted id: its engagement types and the ms epoch it was last known-fresh. */
export interface PersistEntry {
  id: number;
  /** Engagement types for this id (empty = known-not-engaged). */
  t: EngagedModelType[];
  /** ms epoch this id's membership was last observed/written. */
  at: number;
}

export interface PersistBlob {
  v: number;
  userId: number;
  entries: PersistEntry[];
}

// ---------------------------------------------------------------------------
// Pure helpers (no storage / no store) — the correctness surface, unit-tested
// directly.
// ---------------------------------------------------------------------------

/** Parse + shape-validate a raw storage string. Returns null on anything off. */
export function parseBlob(raw: string | null | undefined): PersistBlob | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const b = parsed as Record<string, unknown>;
  if (b.v !== ENGAGED_PERSIST_SCHEMA_VERSION) return null;
  if (typeof b.userId !== 'number' || !Number.isFinite(b.userId)) return null;
  if (!Array.isArray(b.entries)) return null;

  const entries: PersistEntry[] = [];
  for (const raw of b.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'number' || !(e.id > 0)) continue;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
    if (!Array.isArray(e.t)) continue;
    const t = e.t.filter((x): x is EngagedModelType => typeof x === 'string');
    entries.push({ id: e.id, t, at: e.at });
  }
  return { v: b.v, userId: b.userId, entries };
}

export interface FreshSelection {
  /** Reconstructed endpoint-shaped record (per-type id lists) for the store fold. */
  record: EngagedModelsByIdsResult;
  /** Every id that is being marked known (fresh, this user's). */
  queriedIds: number[];
  /** Per-id freshness timestamps to restore into the fetchedAt map. */
  fetchedAt: Array<[number, number]>;
}

/**
 * From a parsed blob, select the ids that belong to `userId` AND are still
 * within `ttlMs` of `now`, reconstructing the exact inputs
 * `store.applyServerResult(record, queriedIds)` expects. Returns null when the
 * blob is missing or belongs to a DIFFERENT user (per-user isolation) — the
 * caller then applies nothing.
 */
export function selectFresh(
  blob: PersistBlob | null,
  userId: number,
  now: number,
  ttlMs: number
): FreshSelection | null {
  if (!blob) return null;
  if (blob.userId !== userId) return null; // isolation: never apply another user's blob

  const record: EngagedModelsByIdsResult = {};
  const queriedIds: number[] = [];
  const fetchedAt: Array<[number, number]> = [];
  for (const e of blob.entries) {
    if (now - e.at > ttlMs) continue; // stale → leave unknown so it re-queries
    queriedIds.push(e.id);
    fetchedAt.push([e.id, e.at]);
    for (const type of e.t) {
      (record[type] ??= []).push(e.id);
    }
  }
  return { record, queriedIds, fetchedAt };
}

/**
 * Build the blob to persist from the live store state + per-id timestamps.
 * Drops stale ids, then caps to the `maxIds` most-recent (oldest evicted).
 */
export function buildBlob(
  userId: number,
  queried: ReadonlySet<number>,
  membership: Record<number, ReadonlySet<EngagedModelType>>,
  fetchedAt: Map<number, number>,
  now: number,
  ttlMs: number,
  maxIds: number
): PersistBlob {
  const entries: PersistEntry[] = [];
  for (const id of queried) {
    if (!(id > 0)) continue;
    const at = fetchedAt.get(id) ?? now;
    if (now - at > ttlMs) continue; // don't persist already-stale ids
    entries.push({ id, t: [...(membership[id] ?? [])], at });
  }
  // Most-recent first, then cap — the oldest ids beyond the cap are evicted.
  entries.sort((a, b) => b.at - a.at);
  if (entries.length > maxIds) entries.length = maxIds;
  return { v: ENGAGED_PERSIST_SCHEMA_VERSION, userId, entries };
}

// ---------------------------------------------------------------------------
// Storage IO (guarded — never throws, no-op when unavailable).
// ---------------------------------------------------------------------------

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function safeRead(): string | null {
  const s = getStorage();
  if (!s) return null;
  try {
    return s.getItem(ENGAGED_PERSIST_STORAGE_KEY);
  } catch {
    return null;
  }
}

function safeWrite(value: string): void {
  const s = getStorage();
  if (!s) return;
  try {
    s.setItem(ENGAGED_PERSIST_STORAGE_KEY, value);
  } catch {
    // quota / private-mode / disabled — memory-only fallback, swallow.
  }
}

function safeRemove(): void {
  const s = getStorage();
  if (!s) return;
  try {
    s.removeItem(ENGAGED_PERSIST_STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

// ---------------------------------------------------------------------------
// Orchestration (module-level, client-only).
// ---------------------------------------------------------------------------

let initializedUserId: number | null = null;
/** id → ms epoch the id was last observed/written (freshness clock). */
let fetchedAt = new Map<number, number>();
let unsubscribe: (() => void) | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let flushListenersAttached = false;

/** Stamp any newly-known id `now` so its TTL clock starts (idempotent per id). */
function stampNewIds(queried: ReadonlySet<number>, now: number): void {
  for (const id of queried) {
    if (!fetchedAt.has(id)) fetchedAt.set(id, now);
  }
}

function persistNow(): void {
  if (initializedUserId == null) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const { membership, queried } = useEngagedModelsStore.getState();
  const now = Date.now();
  // Prune the fetchedAt clock so it can't grow without bound alongside the store.
  for (const id of fetchedAt.keys()) {
    if (!queried.has(id)) fetchedAt.delete(id);
  }
  const blob = buildBlob(
    initializedUserId,
    queried,
    membership,
    fetchedAt,
    now,
    config.ttlMs,
    config.maxIds
  );
  safeWrite(JSON.stringify(blob));
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, config.debounceMs);
}

function attachFlushListeners(): void {
  if (flushListenersAttached || typeof window === 'undefined') return;
  flushListenersAttached = true;
  // Persist the latest state before the tab is backgrounded/closed so the last
  // in-window changes aren't lost with the pending debounce.
  const flush = () => persistNow();
  try {
    window.addEventListener('pagehide', flush);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistNow();
    });
  } catch {
    /* SSR / no-window — ignore */
  }
}

function teardownSubscription(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

/**
 * Idempotently wire persistence for the authenticated `userId` (or tear down for
 * a logged-out `null`). Safe to call from every render/effect: it early-returns
 * when the userId is unchanged. Client-only — a no-op when storage is
 * unavailable (SSR / private mode), leaving the store memory-only.
 *
 * On a userId CHANGE it resets the in-memory store and clears the previous
 * user's persisted blob before rehydrating the new user, so A's state can never
 * bleed into B.
 */
export function initEngagedModelsPersistence(userId: number | null | undefined): void {
  const uid = typeof userId === 'number' && userId > 0 ? userId : null;

  if (uid === initializedUserId) return; // unchanged — nothing to do
  if (!getStorage()) return; // no storage → stay memory-only (today's behavior)

  const switchingUser = initializedUserId !== null && uid !== initializedUserId;

  // Tear down the old user's wiring first so intermediate resets don't persist.
  teardownSubscription();

  if (switchingUser || uid === null) {
    // User changed (or logged out): drop the old user's in-memory + on-disk state.
    useEngagedModelsStore.getState().reset();
    fetchedAt = new Map();
    safeRemove();
  }

  if (uid === null) {
    initializedUserId = null;
    return;
  }

  // Rehydrate this user's fresh ids (post-mount effect → no SSR/hydration issue).
  const blob = parseBlob(safeRead());
  const sel = selectFresh(blob, uid, Date.now(), config.ttlMs);
  if (sel) {
    if (sel.queriedIds.length > 0) {
      useEngagedModelsStore.getState().applyServerResult(sel.record, sel.queriedIds);
    }
    fetchedAt = new Map(sel.fetchedAt);
  } else {
    // Blob absent or belongs to another user → apply nothing; clear a foreign blob.
    if (blob) safeRemove();
    fetchedAt = new Map();
  }

  initializedUserId = uid;

  // Subscribe AFTER rehydration so the fold above doesn't trigger a persist.
  unsubscribe = useEngagedModelsStore.subscribe((state) => {
    stampNewIds(state.queried, Date.now());
    schedulePersist();
  });
  // Seed the clock for any ids already present (e.g. queried before init ran).
  stampNewIds(useEngagedModelsStore.getState().queried, Date.now());
  attachFlushListeners();
}

/** Force an immediate write-back (used by the flush listeners and by tests). */
export function flushEngagedModelsPersistence(): void {
  persistNow();
}

/** Test helper: reset ALL module state (does not touch storage). */
export function __resetEngagedModelsPersistenceForTests(): void {
  teardownSubscription();
  initializedUserId = null;
  fetchedAt = new Map();
  flushListenersAttached = false;
}

/** Test helper: override TTL / cap / debounce. Returns a restore fn. */
export function __setEngagedPersistConfigForTests(partial: Partial<PersistConfig>): () => void {
  const prev = { ...config };
  Object.assign(config, partial);
  return () => Object.assign(config, prev);
}

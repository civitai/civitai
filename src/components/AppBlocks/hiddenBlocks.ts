import { useEffect, useState } from 'react';

/**
 * Viewer-local "hide this app block" state, persisted to localStorage.
 *
 * App blocks installed by a model's owner ("show on my models" publisher
 * installs) appear to every viewer of that model. A viewer who doesn't want a
 * given block can hide it locally via the host trust-frame's ⋯ menu — the
 * choice lives only in their browser (localStorage), never on the server, so it
 * doesn't affect the publisher's install or other viewers. Hidden blocks can be
 * restored from the "Hidden" tab on /apps/installed.
 *
 * Keyed on `blockInstanceId` (the specific install instance) so hiding a block
 * on one model doesn't hide the same app on another. A little metadata (app +
 * model name) is stored alongside so the restore list reads meaningfully
 * without a server lookup. The set is read reactively (`useHiddenBlocks` /
 * `useHiddenBlockList`) so a hide/restore updates the slot AND the manage page
 * immediately, and a hidden block never mounts (or mints a token) on reload.
 */
export interface HiddenBlock {
  blockInstanceId: string;
  /** App (block) display name, for the restore list. */
  appName?: string;
  /** Model the block was hidden on, for the restore list link/label. */
  modelId?: number;
  modelName?: string;
  /** Epoch ms when hidden (0 for entries migrated from the legacy shape). */
  hiddenAt: number;
}

const STORAGE_KEY = 'civitai:app-blocks:hidden';
// In-page event so a hide/restore triggered anywhere re-renders every mounted
// consumer (the slot that's rendering the block, the manage page) without prop
// threading.
const HIDDEN_CHANGED_EVENT = 'civitai:app-blocks:hidden-changed';

function readMap(): Record<string, HiddenBlock> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Back-compat: the first shipped shape was a bare string[] of instance ids.
    if (Array.isArray(parsed)) {
      const out: Record<string, HiddenBlock> = {};
      for (const id of parsed) {
        if (typeof id === 'string') out[id] = { blockInstanceId: id, hiddenAt: 0 };
      }
      return out;
    }
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, HiddenBlock> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          const v = value as Record<string, unknown>;
          if (typeof v.blockInstanceId !== 'string') continue;
          out[key] = {
            blockInstanceId: v.blockInstanceId,
            appName: typeof v.appName === 'string' ? v.appName : undefined,
            modelId: typeof v.modelId === 'number' ? v.modelId : undefined,
            modelName: typeof v.modelName === 'string' ? v.modelName : undefined,
            hiddenAt: typeof v.hiddenAt === 'number' ? v.hiddenAt : 0,
          };
        }
      }
      return out;
    }
    return {};
  } catch {
    // Corrupt value / disabled storage → treat as nothing hidden.
    return {};
  }
}

function writeMap(map: Record<string, HiddenBlock>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private mode / quota / disabled — best-effort; a failed persist just
    // means the choice won't survive reload.
  }
}

function emitChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(HIDDEN_CHANGED_EVENT));
  }
}

export function isBlockHidden(blockInstanceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readMap(), blockInstanceId);
}

/**
 * Locally hide a block instance for this viewer. Persists to localStorage and
 * notifies mounted consumers. No-op (no event) if already hidden.
 */
export function hideBlock(block: HiddenBlock): void {
  if (typeof window === 'undefined') return;
  const map = readMap();
  if (map[block.blockInstanceId]) return;
  map[block.blockInstanceId] = block;
  writeMap(map);
  emitChange();
}

/**
 * Restore (un-hide) a previously hidden block instance. No-op (no event) if it
 * wasn't hidden.
 */
export function unhideBlock(blockInstanceId: string): void {
  if (typeof window === 'undefined') return;
  const map = readMap();
  if (!map[blockInstanceId]) return;
  delete map[blockInstanceId];
  writeMap(map);
  emitChange();
}

/**
 * Subscribe a derived value to hidden-store changes. Empty/initial on the
 * server + first client render (so SSR and hydration agree), then recomputed
 * from localStorage in an effect and kept in sync via the in-page event +
 * cross-tab `storage` events.
 */
function useHiddenStore<T>(compute: () => T, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sync = () => setValue(compute());
    sync();
    window.addEventListener(HIDDEN_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
    // compute is a stable module-local closure per call site; intentionally
    // not in deps (it would resubscribe every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

/** Reactive set of hidden `blockInstanceId`s — for BlockSlotClient filtering. */
export function useHiddenBlocks(): Set<string> {
  return useHiddenStore(() => new Set(Object.keys(readMap())), new Set<string>());
}

/** Reactive list of hidden blocks (newest first) — for the restore UI. */
export function useHiddenBlockList(): HiddenBlock[] {
  return useHiddenStore(
    () => Object.values(readMap()).sort((a, b) => b.hiddenAt - a.hiddenAt),
    [] as HiddenBlock[]
  );
}

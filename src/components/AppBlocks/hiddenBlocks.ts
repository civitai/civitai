import { useEffect, useState } from 'react';

/**
 * Viewer-local "hide this app block" state, persisted to localStorage.
 *
 * App blocks installed by a model's owner ("show on my models" publisher
 * installs) appear to every viewer of that model. A viewer who doesn't want a
 * given block can hide it locally via the host trust-frame's ⋯ menu — the
 * choice lives only in their browser (localStorage), never on the server, so it
 * doesn't affect the publisher's install or other viewers.
 *
 * Keyed on `blockInstanceId` (the specific install instance) so hiding a block
 * on one model doesn't hide the same app on another. The set is read reactively
 * via `useHiddenBlocks()` so a hide unmounts the block immediately AND keeps it
 * hidden on reload, without ever mounting (and minting a token for) a hidden
 * block.
 */

const STORAGE_KEY = 'civitai:app-blocks:hidden';
// In-page event so a hide triggered deep in the trust frame re-filters the
// BlockSlot that's rendering it (no prop threading through the host stack).
const HIDDEN_CHANGED_EVENT = 'civitai:app-blocks:hidden-changed';

function readHidden(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set();
  } catch {
    // Corrupt value / disabled storage → treat as nothing hidden.
    return new Set();
  }
}

function writeHidden(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Private mode / quota / disabled — hide is best-effort; a failed persist
    // just means it won't survive reload.
  }
}

export function isBlockHidden(blockInstanceId: string): boolean {
  return readHidden().has(blockInstanceId);
}

/**
 * Locally hide a block instance for this viewer. Persists to localStorage and
 * dispatches an in-page event so any mounted BlockSlot re-filters at once.
 */
export function hideBlock(blockInstanceId: string): void {
  if (typeof window === 'undefined') return;
  const set = readHidden();
  if (set.has(blockInstanceId)) return;
  set.add(blockInstanceId);
  writeHidden(set);
  window.dispatchEvent(new CustomEvent(HIDDEN_CHANGED_EVENT));
}

/**
 * Reactive view of the hidden-block set. Empty on the server + first client
 * render (so SSR and hydration agree), then populated from localStorage in an
 * effect and kept in sync via the in-page hide event + cross-tab `storage`
 * events.
 */
export function useHiddenBlocks(): Set<string> {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const sync = () => setHidden(readHidden());
    sync();
    window.addEventListener(HIDDEN_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return hidden;
}

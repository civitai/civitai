import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePushSubscriptionStore } from '~/store/push-subscription.store';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STORE_FILE = 'src/store/push-subscription.store.ts';
const HOOK_FILE = 'src/components/Notifications/usePushSubscription.ts';

const INITIAL = {
  support: 'unsupported' as const,
  permission: null,
  subscribed: false,
  currentEndpoint: null,
  busy: false,
};

beforeEach(() => {
  usePushSubscriptionStore.setState(INITIAL);
});

describe('push subscription store', () => {
  it('is a single shared instance — a write through one reader is visible to another', () => {
    // The defect this store exists to fix: PushDeviceToggle and PushDeviceList each mounted
    // usePushSubscription and got their own useState, so revoking the current device from the list
    // left the toggle rendering `checked` for a device that had just been revoked.
    const readerA = usePushSubscriptionStore.getState();
    readerA.set({ subscribed: true, currentEndpoint: 'https://push.test/abc' });

    const readerB = usePushSubscriptionStore.getState();
    expect(readerB.subscribed).toBe(true);
    expect(readerB.currentEndpoint).toBe('https://push.test/abc');

    readerB.set({ subscribed: false, currentEndpoint: null });
    expect(usePushSubscriptionStore.getState().subscribed).toBe(false);
  });

  it('patches only the named fields', () => {
    usePushSubscriptionStore.getState().set({ busy: true });
    const state = usePushSubscriptionStore.getState();
    expect(state.busy).toBe(true);
    expect(state.subscribed).toBe(false);
    expect(state.support).toBe('unsupported');
  });

  it('starts from the SSR-safe defaults', () => {
    // A server render must produce exactly what the old per-instance useState defaults produced.
    const state = usePushSubscriptionStore.getState();
    expect(state.support).toBe('unsupported');
    expect(state.permission).toBeNull();
    expect(state.subscribed).toBe(false);
    expect(state.currentEndpoint).toBeNull();
    expect(state.busy).toBe(false);
  });
});

/**
 * Blanks out the body of every `useEffect(...)` / `useCallback(...)` call by matching balanced
 * parens, so whatever `setState(` survives in the remainder is reachable during RENDER.
 *
 * Deliberately not a "is there a useEffect earlier in the file" check. That was the first version
 * of this guard and it was positional, not structural: the hook's first `useEffect(` is near the
 * top, so every write below it passed unconditionally and a render-phase write added anywhere
 * lower survived the guard untouched.
 */
function stripHookBodies(source: string): string {
  let out = source;
  for (const fn of ['useEffect', 'useCallback']) {
    let from = 0;
    for (;;) {
      const start = out.indexOf(`${fn}(`, from);
      if (start === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = start + fn.length; i < out.length; i++) {
        if (out[i] === '(') depth++;
        else if (out[i] === ')') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break; // unbalanced — leave the rest intact rather than silently eat it
      out = out.slice(0, start) + ' '.repeat(end - start + 1) + out.slice(end + 1);
      from = start + 1;
    }
  }
  return out;
}

/**
 * The store documents its SSR-safety as something a future edit can silently break. This is the
 * guard for exactly that property, pinned structurally because there is no runtime moment at
 * which a cross-request leak would be observable in a unit test.
 *
 * The module is a singleton shared by every request the node process serves, so any write that can
 * run during a server render would leak one user's push state into another user's HTML. Writes are
 * safe only while they are reachable solely from an effect or a user callback.
 */
describe('SSR safety (structural)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('is imported by exactly one module across all of src/', () => {
    // Scans src/ ENTIRELY. An earlier version listed four directories, so a second importer under
    // src/hooks/ or src/components/AppLayout/ — both of which exist — would have been missed.
    const importers = walk(path.join(REPO_ROOT, 'src'))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !f.endsWith(path.normalize(STORE_FILE)))
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('usePushSubscriptionStore'))
      .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))
      .sort();

    // Exactly one: the hook. A second importer — even a read-only one — means every write is no
    // longer provably browser-only from one file, so this must be RE-REASONED, not just updated.
    expect(importers).toEqual([HOOK_FILE]);
  });

  it('never calls the imperative setState/getState escape hatches outside tests', () => {
    // `usePushSubscriptionStore.setState(...)` at module scope would run on the server on import.
    const hook = read(HOOK_FILE);
    expect(hook).not.toMatch(/usePushSubscriptionStore\s*\.\s*setState\s*\(/);
    expect(hook).not.toMatch(/usePushSubscriptionStore\s*\.\s*getState\s*\(/);
  });

  it('reaches every store write from an effect or a callback, never from render', () => {
    const hook = read(HOOK_FILE);

    // Positive control: the writes exist and this guard can see them. Without it, a rename of
    // `setState` would make the assertion below pass over an empty set.
    expect(hook.match(/\bsetState\s*\(/g)?.length ?? 0).toBeGreaterThan(0);

    const renderReachable = stripHookBodies(hook).match(/\bsetState\s*\(/g) ?? [];
    expect(renderReachable).toEqual([]);
  });
});

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

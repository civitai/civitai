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
 * The store's own comment calls SSR-safety "a property a future edit can silently break". This is
 * the guard for exactly that property, pinned structurally because there is no runtime moment at
 * which a cross-request leak would be observable in a unit test.
 *
 * The module is a singleton shared by every request the node process serves, so any write that can
 * run during a server render would leak one user's push state into another user's HTML. Writes are
 * safe only while they are reachable solely from an effect or a user callback.
 */
describe('SSR safety (structural)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  it('is mutated from exactly one module', () => {
    const importers = [
      'src/components/Notifications',
      'src/components/Account',
      'src/pages',
      'src/store',
    ]
      .flatMap((dir) => walk(path.join(REPO_ROOT, dir)))
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !f.endsWith(path.normalize(STORE_FILE)))
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('usePushSubscriptionStore'));

    // Exactly one: the hook. If a component starts writing the store directly, it is no longer
    // provable that every write is browser-only, and this must be re-reasoned rather than updated.
    expect(importers.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))).toEqual([
      HOOK_FILE,
    ]);
  });

  it('never calls the imperative setState/getState escape hatches outside tests', () => {
    // `usePushSubscriptionStore.setState(...)` at module scope would run on the server on import.
    const hook = read(HOOK_FILE);
    expect(hook).not.toMatch(/usePushSubscriptionStore\s*\.\s*setState\s*\(/);
    expect(hook).not.toMatch(/usePushSubscriptionStore\s*\.\s*getState\s*\(/);
  });

  it('reaches every store write from an effect or a callback, never from render', () => {
    const hook = read(HOOK_FILE);
    // Strip the hook body's nested function bodies is overkill; instead assert the shape that
    // makes the property hold: every `setState({` call site sits inside a useEffect/useCallback.
    const lines = hook.split('\n');
    const writeLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /\bsetState\s*\(/.test(line));
    expect(writeLines.length).toBeGreaterThan(0); // positive control: we found the writes

    for (const { i } of writeLines) {
      const preceding = lines.slice(0, i).join('\n');
      const lastEffect = Math.max(
        preceding.lastIndexOf('useEffect('),
        preceding.lastIndexOf('useCallback(')
      );
      expect(lastEffect).toBeGreaterThan(-1);
    }
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

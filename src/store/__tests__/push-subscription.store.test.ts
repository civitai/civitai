import fs from 'fs';
import path from 'path';
import ts from 'typescript';
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
 * Names that make a call's body run OUTSIDE render. Kept explicit rather than pattern-matched on
 * `/^use.*Effect$/` so adding one is a deliberate act: a hook wrongly listed here would make a
 * render-phase write invisible to the guard below.
 */
const DEFERRED_HOOKS = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
  'useCallback',
  'useMemo',
]);

/**
 * Returns the `setState(...)` calls that are reachable during RENDER — i.e. not lexically inside
 * one of DEFERRED_HOOKS' callbacks.
 *
 * Parsed with the TypeScript compiler rather than scanned for balanced parens. The paren-matching
 * version this replaces could not tell code from data: a single unmatched `(` inside an ordinary
 * string (`'push support (beta'`) or the token `useCallback(` inside a COMMENT desynchronised the
 * scan, which then abandoned every remaining body and reported its legitimate in-effect writes as
 * render-phase. The failure text pointed at SSR leakage, which was not what had happened. It also
 * knew only two hook names, so a `useLayoutEffect` body counted as render.
 */
function renderPhaseWrites(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const isDeferred = (node: ts.Node): boolean => {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression)) {
        if (DEFERRED_HOOKS.has(cur.expression.text)) return true;
      }
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setState' &&
      !isDeferred(node)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push(`${fileName}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

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

  it('reaches every store write from a deferred hook, never from render', () => {
    const hook = read(HOOK_FILE);
    // Positive control on the SOURCE: the writes exist at all.
    expect(hook.match(/\bsetState\s*\(/g)?.length ?? 0).toBeGreaterThan(0);
    expect(renderPhaseWrites(HOOK_FILE, hook)).toEqual([]);
  });

  // Controls on the INSTRUMENT, not on the hook. A guard that has only ever been run against
  // passing input is a claim about that input: these pin that it can go red, and — the direction
  // the previous version got wrong — that it does NOT go red on legitimate code.
  it('flags a write that is genuinely reachable during render', () => {
    const src = [
      'export function useThing() {',
      '  const setState = useStore((s) => s.set);',
      '  setState({ busy: true });',
      '  useEffect(() => setState({ busy: false }), []);',
      '  return null;',
      '}',
    ].join('\n');
    expect(renderPhaseWrites('fixture.ts', src)).toEqual(['fixture.ts:3']);
  });

  it.each([
    ['an unbalanced paren inside a string', "  const note = 'push support (beta';"],
    ['a hook name inside a comment', '  // TODO: hoist into a useCallback( later'],
    ['a regex containing a paren', '  const re = /\\((\\d+)/;'],
  ])('does not flag legitimate code containing %s', (_label, line) => {
    const src = [
      'export function useThing() {',
      '  const setState = useStore((s) => s.set);',
      '  useEffect(() => {',
      line,
      '    setState({ busy: false });',
      '  }, []);',
      '}',
    ].join('\n');
    expect(renderPhaseWrites('fixture.ts', src)).toEqual([]);
  });

  it('treats useLayoutEffect as deferred, not as render', () => {
    const src = [
      'export function useThing() {',
      '  const setState = useStore((s) => s.set);',
      '  useLayoutEffect(() => setState({ busy: false }), []);',
      '}',
    ].join('\n');
    expect(renderPhaseWrites('fixture.ts', src)).toEqual([]);
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

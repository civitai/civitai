import { vi, type Mock } from 'vitest';

/**
 * The primitive behind every canonical shared-module mock.
 *
 * A hybrid node is simultaneously a `vi.fn()` and a proxy that vivifies child nodes on
 * property access, so `dbRead.image.findMany`, `dbRead.$queryRaw` and `redis.packed.get`
 * all exist without anyone enumerating Prisma's ~60x15 surface or Redis's command list.
 * Enumerating by hand is how the current per-file mocks became partial in the first place.
 *
 * 🔴 A child node is CACHED, so its identity never changes for the lifetime of the worker.
 * That is the load-bearing property, not a memoisation nicety. With `isolate: false` an
 * ordinary source module that imports a mocked module is evaluated once per worker and
 * captures its bindings then and there; it never re-reads them. So behaviour has to be
 * swapped by mutating a stable function, never by handing out a fresh one. Replacing the
 * object is precisely what breaks ~1,500 tests today.
 *
 * See docs/testing/shared-module-mocks.md for the probe that establishes this.
 */

export type HybridNode = Mock<(...args: any[]) => any> & {
  [key: string]: HybridNode;
};

/** Never resolve these to a child node: a node must not look like a thenable, or `await`ing
 * one (or returning one from an async function) would call it and hang. */
const NON_VIVIFIED = new Set(['then', 'catch', 'finally']);

const nodes = new Map<string, HybridNode>();
const fns = new Map<string, Mock<(...args: any[]) => any>>();
const defaults = new Map<string, ((...args: any[]) => any) | undefined>();
/** Per-node data properties a test assigned directly. Cleared by the per-file reset. */
const assignments = new Map<string, Map<string, unknown>>();

let defaultResolver: (path: string) => ((...args: any[]) => any) | undefined = () => undefined;

/**
 * Install the function that decides a node's post-reset behaviour from its dotted path.
 * Called once per canonical mock module (see db.mock.ts) — later registrations compose
 * rather than replace, so db's resolver and redis's can coexist in one registry.
 */
export function registerDefaults(resolve: (path: string) => ((...args: any[]) => any) | undefined) {
  const previous = defaultResolver;
  defaultResolver = (path) => resolve(path) ?? previous(path);
}

export function hybridNode(path: string): HybridNode {
  const cached = nodes.get(path);
  if (cached) return cached;

  const fn = vi.fn();
  // Names the spy after its path, so a failed `toHaveBeenCalledWith` reads
  // `dbRead.image.findMany` rather than `spy`.
  fn.mockName(path);
  fns.set(path, fn);
  applyDefault(path, fn);

  // 🔴 Data a test ASSIGNS to a node — `sysRedis.isReady = false` is the real case — has to
  // be tracked separately and cleared by the reset. Without a `set` trap it lands on the
  // underlying `vi.fn` as an own property, and `mockReset()` clears mock state but not
  // arbitrary properties: under `isolate: false` the value then persists for the whole life
  // of the worker and leaks into every later file. (Found by donovan, who bounded it with a
  // local `afterEach`; this is the general fix.)
  const assigned = new Map<string, unknown>();
  assignments.set(path, assigned);

  const proxy = new Proxy(fn, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (NON_VIVIFIED.has(prop)) return undefined;
      // An explicit assignment wins over everything: the test said so this file.
      if (assigned.has(prop)) return assigned.get(prop);
      // A real `vi.fn` member (mockResolvedValue, mock, mockReset, …) or a
      // Function.prototype member wins over vivification. A Prisma model or Redis
      // command sharing one of those names is unreachable through property access —
      // none exist today; `mockNode()` is the escape hatch if one ever does.
      if (prop in target) return Reflect.get(target, prop, receiver);
      return hybridNode(`${path}.${prop}`);
    },
    set(_target, prop, value) {
      if (typeof prop === 'string') assigned.set(prop, value);
      return true;
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'string') assigned.delete(prop);
      return true;
    },
    // Guards `'someModel' in dbRead` style checks in production code.
    has() {
      return true;
    },
  }) as HybridNode;

  nodes.set(path, proxy);
  return proxy;
}

/** Address a node by its dotted path — the escape hatch for a name that collides with a
 * `vi.fn` member, and the way to assert on a node without vivifying it through a getter. */
export function mockNode(path: string): HybridNode {
  return hybridNode(path);
}

function applyDefault(path: string, fn: Mock<(...args: any[]) => any>) {
  const impl = defaults.has(path) ? defaults.get(path) : defaultResolver(path);
  defaults.set(path, impl);
  if (impl) fn.mockImplementation(impl);
}

/**
 * Called once per test file from the global setup, BEFORE the test module is imported.
 * `mockReset` clears implementation and call history together, which is what kills the
 * pooled-call-count failures; the registered default is then re-applied so an unrelated
 * code path still gets a plausible empty answer instead of `undefined.map is not a
 * function`.
 */
export function resetHybridNodes() {
  // Assigned data first: `sysRedis.isReady = false` is not mock state, so `mockReset()` does
  // not touch it, and under `isolate: false` it would otherwise outlive the file that set it.
  for (const assigned of assignments.values()) assigned.clear();
  for (const [path, fn] of fns) {
    fn.mockReset();
    fn.mockName(path);
    const impl = defaults.get(path);
    if (impl) fn.mockImplementation(impl);
  }
}

/** Test-only introspection: how many nodes have ever been vivified in this worker. */
export function hybridNodeCount() {
  return fns.size;
}

import { hybridNode, registerDefaults, type HybridNode } from './hybrid';
// Type-only, so it is erased and does NOT evaluate the module — the hazard the seam below
// documents is a value import. Keep it `import type`; a plain import reintroduces it.
import type * as SysReadDeadline from '~/server/redis/sys-read-deadline';

/**
 * Canonical mock for `~/server/redis/client` — `redis` and `sysRedis`.
 *
 * The wrapper's namespaced surface (`redis.packed.get`, `redis.purgeTags`, …) comes for
 * free from the hybrid node: any depth of property access vivifies, so nothing here has
 * to track what `@civitai/redis` exports.
 *
 *   import { redisMock } from '~/__tests__/mocks/redis.mock';
 *   redisMock.sysRedis.hGetAll.mockResolvedValue({ '1': 'x' });
 */

const ROOTS = ['redis', 'sysRedis'];

const nullish = () => Promise.resolve(null);
const emptyArray = () => Promise.resolve([] as unknown[]);
const emptyObject = () => Promise.resolve({} as Record<string, unknown>);
const zero = () => Promise.resolve(0);
const ok = () => Promise.resolve('OK');

/**
 * Read-shaped commands default to "cache miss" rather than undefined. A miss is the
 * branch production code is written to survive, so an unmigrated path that reaches an
 * undeclared command degrades the way it would in a cold cache instead of throwing.
 */
const DEFAULTS: Record<string, () => Promise<unknown>> = {
  get: nullish,
  getEx: nullish,
  hGet: nullish,
  hGetAll: emptyObject,
  mGet: emptyArray,
  hmGet: emptyArray,
  sMembers: emptyArray,
  sIsMember: () => Promise.resolve(false),
  zRange: emptyArray,
  zRangeWithScores: emptyArray,
  lRange: emptyArray,
  keys: emptyArray,
  scan: () => Promise.resolve({ cursor: 0, keys: [] }),
  exists: zero,
  ttl: () => Promise.resolve(-1),
  del: zero,
  sCard: zero,
  incr: zero,
  decr: zero,
  set: ok,
  setEx: ok,
  hSet: zero,
  expire: () => Promise.resolve(true),
  ping: () => Promise.resolve('PONG'),
};

/**
 * `withSysReadDeadline` is a SEAM, not a command: a test injects a sysRedis read timeout by
 * replacing it, which is the only lever it has — the deadline is a wall-clock race the mocked
 * client can never lose on its own.
 *
 * 🔴 Its default is the REAL implementation, deliberately. `setup.ts` spread the real module
 * into the canonical factory, so every migrated file has been running the real wrapper; a
 * pass-through default would silently disarm a live guard in every file in the worker to give
 * nine files a lever. Wrapping the real function is the only version of this that adds a seam
 * and changes nothing else.
 *
 * 🔴 Resolved by a LAZY import, not a top-level one. This module is loaded from `setup.ts`, which
 * also registers the `~/env/server` mock — and `vi.mock` is hoisted above it. A static
 * `import … from '~/server/redis/sys-read-deadline'` therefore evaluates that module (and its
 * `import { env }`) before the env mock's factory has initialised, and the whole file collects
 * ZERO tests with `Cannot access '__vi_import_4__' before initialization`.
 */
let realModule: typeof SysReadDeadline | undefined;

const SEAMS: Record<string, (...args: any[]) => any> = {
  withSysReadDeadline: async (...args: any[]) => {
    realModule ??= await import('~/server/redis/sys-read-deadline');
    return realModule.withSysReadDeadline(...(args as [Promise<unknown>, number?]));
  },
};

registerDefaults((path) => {
  if (SEAMS[path]) return SEAMS[path];
  const dot = path.indexOf('.');
  // A root path with no dot is not a command; `slice(0, -1)` would silently truncate it into
  // one that never matches, which is how a resolver returns undefined for the wrong reason.
  if (dot === -1) return undefined;
  if (!ROOTS.includes(path.slice(0, dot))) return undefined;
  return DEFAULTS[path.slice(path.lastIndexOf('.') + 1)];
});

export const redisMock: {
  redis: HybridNode;
  sysRedis: HybridNode;
  withSysReadDeadline: HybridNode;
} = {
  redis: hybridNode('redis'),
  sysRedis: hybridNode('sysRedis'),
  withSysReadDeadline: hybridNode('withSysReadDeadline'),
};

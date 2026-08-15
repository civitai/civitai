import { hybridNode, registerDefaults, type HybridNode } from './hybrid';

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

registerDefaults((path) => {
  const root = path.slice(0, path.indexOf('.'));
  if (!ROOTS.includes(root)) return undefined;
  return DEFAULTS[path.slice(path.lastIndexOf('.') + 1)];
});

export const redisMock: { redis: HybridNode; sysRedis: HybridNode } = {
  redis: hybridNode('redis'),
  sysRedis: hybridNode('sysRedis'),
};

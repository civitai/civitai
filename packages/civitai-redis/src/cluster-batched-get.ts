// Batched multi-key GET for the cache CLUSTER client: one command per owning master instead of one
// GET per key.
//
// WHY: a plain MGET across keys in different hash slots fails with CROSSSLOT, so `packed.mGet` used
// to issue one GET per key. Per-id caches (createCachedArray) read up to 200 keys per call, and
// those keys land in ~200 distinct slots, so grouping by SLOT would save nothing. Grouping by the
// MASTER that owns the slots does: a Lua script declared with `allow-cross-slot-keys` may read keys
// from any slot the node it runs on serves (Redis 7.0+). So a batch costs one EVALSHA per master
// rather than one GET per key.
//
// Keys and values are unchanged — this is a read-path change only, with no migration.
//
// SAFETY: the script can only ever return what the node holds for a key it currently serves. If
// the client's slot map is stale (a reshard, a failover), the script hits a key the node does not
// serve and Redis fails the WHOLE script ("non local key"), and a key in a slot that is migrating
// away fails it the same way. A failed group is re-read with the original per-key GETs, which
// follow MOVED/ASK. So a failure costs one extra round-trip for that group and never returns a
// wrong value or a false miss. If the per-key fallback also fails, the call rejects exactly as
// before (callers already fail open on a rejected read).
import calculateSlot from 'cluster-key-slot';
import { createHash } from 'node:crypto';

/**
 * Reads KEYS[1] then every ARGV key, in order. `redis.call('GET', missing)` yields `false`, which
 * keeps its table slot (a `nil` would end the array early) and is returned as a null reply, so the
 * reply always has exactly one entry per key.
 *
 * `no-writes` lets Redis run it on a read-only node and under OOM; `allow-cross-slot-keys` is what
 * permits the ARGV keys to sit in other slots of the same node. Only KEYS[1] is declared, so the
 * client routes the call by that key and Redis' own routing check sees a single slot.
 */
export const NODE_LOCAL_GET_SCRIPT = `#!lua flags=no-writes,allow-cross-slot-keys
local out = {}
out[1] = redis.call('GET', KEYS[1])
for i = 1, #ARGV do
  out[i + 1] = redis.call('GET', ARGV[i])
end
return out`;

export const NODE_LOCAL_GET_SHA = createHash('sha1').update(NODE_LOCAL_GET_SCRIPT).digest('hex');

/**
 * Upper bound on keys read by one script call. The script blocks its node while it runs, so this
 * bounds that stall (each GET is a hash lookup; 100 of them is well under a millisecond).
 */
export const NODE_LOCAL_GET_MAX_KEYS = 100;

export type ScriptArgs = { keys: string[]; arguments: string[] };

export type BatchedGetDeps<V> = {
  /** A single GET, routed and redirected by the client as usual. */
  get(key: string): Promise<V | null>;
  evalSha(sha: string, args: ScriptArgs): Promise<unknown>;
  eval(script: string, args: ScriptArgs): Promise<unknown>;
  /**
   * Identity of the master the client currently believes owns `slot`, or undefined when the slot
   * map does not know it yet. Only used to GROUP keys; correctness never depends on it (see SAFETY).
   */
  nodeOf(slot: number): string | undefined;
  /** True when a reply element is a usable value (e.g. a Buffer for the buffer client). */
  isValue(v: unknown): v is V;
  /** Called once per group that fell back to per-key GETs. */
  onFallback?(err: unknown, keyCount: number): void;
};

function isNoScript(err: unknown) {
  return err instanceof Error && err.message.startsWith('NOSCRIPT');
}

async function runScript<V>(keys: string[], deps: BatchedGetDeps<V>): Promise<(V | null)[]> {
  const args: ScriptArgs = { keys: [keys[0]], arguments: keys.slice(1) };
  let reply: unknown;
  try {
    reply = await deps.evalSha(NODE_LOCAL_GET_SHA, args);
  } catch (err) {
    // Scripts are cached per node and lost on restart; EVAL loads it again.
    if (!isNoScript(err)) throw err;
    reply = await deps.eval(NODE_LOCAL_GET_SCRIPT, args);
  }
  // Positional: a reply of the wrong shape must not be mapped onto keys.
  if (!Array.isArray(reply) || reply.length !== keys.length) {
    throw new Error(
      `node-local GET returned ${Array.isArray(reply) ? reply.length : typeof reply} entries for ${
        keys.length
      } keys`
    );
  }
  return reply.map((v) => {
    if (v === null || v === undefined) return null;
    if (!deps.isValue(v)) throw new Error(`node-local GET returned a ${typeof v} element`);
    return v;
  });
}

/**
 * Same contract as `Promise.all(keys.map(get))`: one entry per key, in order, null for a missing
 * key; rejects only if a key could not be read even by a plain GET.
 */
export async function batchedGet<V>(
  keys: string[],
  deps: BatchedGetDeps<V>
): Promise<(V | null)[]> {
  if (keys.length <= 1) return Promise.all(keys.map((k) => deps.get(k)));

  // Group key POSITIONS by owning master (duplicates are read once per position, as before).
  const groups = new Map<string, number[]>();
  const ungrouped: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    const node = deps.nodeOf(calculateSlot(keys[i]));
    if (node === undefined) {
      ungrouped.push(i);
      continue;
    }
    let group = groups.get(node);
    if (!group) groups.set(node, (group = []));
    group.push(i);
  }

  const parts: number[][] = ungrouped.map((i) => [i]);
  for (const group of groups.values()) {
    for (let s = 0; s < group.length; s += NODE_LOCAL_GET_MAX_KEYS)
      parts.push(group.slice(s, s + NODE_LOCAL_GET_MAX_KEYS));
  }

  const out: (V | null)[] = new Array(keys.length).fill(null);
  await Promise.all(
    parts.map(async (part) => {
      const partKeys = part.map((i) => keys[i]);
      let values: (V | null)[];
      if (partKeys.length === 1) {
        values = [await deps.get(partKeys[0])];
      } else {
        try {
          values = await runScript(partKeys, deps);
        } catch (err) {
          deps.onFallback?.(err, partKeys.length);
          values = await Promise.all(partKeys.map((k) => deps.get(k)));
        }
      }
      for (let j = 0; j < part.length; j++) out[part[j]] = values[j];
    })
  );
  return out;
}

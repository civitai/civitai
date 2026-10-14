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
// away fails it the same way.
//
// 🔴 One redirect is NOT refused that way: when the script's FIRST key has already moved out of a
// migrating slot, Redis answers ASK and the client re-sends the script to the importing node with
// ASKING. ASKING carries into every redis.call of the script, so that node serves EVERY key of the
// importing slot — including keys still on the source, which it does not have — as nil: a false
// miss in a well-formed reply. So the script also returns the id of the node it ran on, and a
// reply from any node other than the one the group was built for is discarded. (Reproduced on a
// real 7.4 cluster; see the integration test.) A MOVED followed by an ASK can bring the script
// back to the expected node WITH ASKING; that path is caught because the MOVED changes the
// client's slot map, which is re-checked after the reply.
//
// A group whose script Redis REFUSED (an error reply), or whose reply is unusable (wrong shape,
// wrong node), is re-read with the original per-key GETs, which follow MOVED/ASK. So such a
// failure costs one extra round-trip for that group and never returns a wrong value or a false
// miss. A TRANSPORT failure (deadline, closed or reconnecting connection) is not retried key by
// key: those GETs would go to the same struggling node, so the call rejects as a failed GET did
// before, and callers fail open as before. Every error REPLY falls back, including ones a GET would
// also get (LOADING, BUSY, CLUSTERDOWN): those GETs then fail and the call rejects as before, at
// the cost of one extra script per cooldown. Falling back too eagerly costs a round-trip; failing
// too eagerly would send the whole batch to the database, so the classification errs this way.
//
// After a fallback the getter stops using the script for a cooldown, so a topology change does not
// cost a failed script plus N GETs on every call while the slot map catches up.
import calculateSlot from 'cluster-key-slot';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ErrorReply } from 'redis';

/**
 * Reads KEYS[1] then every ARGV key, in order, then appends this node's id (CLUSTER MYID) — see
 * SAFETY. `redis.call('GET', missing)` yields `false`, which keeps its table slot (a `nil` would
 * end the array early) and is returned as a null reply, so the reply always has exactly one entry
 * per key plus the node id.
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
out[#ARGV + 2] = redis.call('CLUSTER', 'MYID')
return out`;

export const NODE_LOCAL_GET_SHA = createHash('sha1').update(NODE_LOCAL_GET_SCRIPT).digest('hex');

/**
 * Upper bound on keys read by one script call. The script blocks its node while it runs, so this
 * bounds that stall (a local bench measured ~0.13 ms of server CPU for a ~67-key script).
 */
export const NODE_LOCAL_GET_MAX_KEYS = 100;

/** How long the getter uses per-key GETs only, after a group had to fall back. */
export const NODE_LOCAL_GET_FALLBACK_COOLDOWN_MS = 10_000;

export type ScriptArgs = { keys: string[]; arguments: string[] };

export type BatchedGetDeps<V> = {
  /** A single GET, routed and redirected by the client as usual. */
  get(key: string): Promise<V | null>;
  evalSha(sha: string, args: ScriptArgs): Promise<unknown>;
  eval(script: string, args: ScriptArgs): Promise<unknown>;
  /**
   * Node id (as CLUSTER MYID reports it) of the master the client currently believes owns `slot`,
   * or undefined when the slot map does not know it. Groups keys, and is checked against the id
   * the script reports, so a stale or wrong answer costs a fallback, never a wrong value.
   */
  nodeOf(slot: number): string | undefined;
  /** True when a reply element is a usable value (e.g. a Buffer for the buffer client). */
  isValue(v: unknown): v is V;
  /** True for an error REPLY from Redis (as opposed to a transport/client-side failure). */
  isServerError(err: unknown): boolean;
  /** Called when a group falls back to per-key GETs and a cooldown starts. */
  onFallback?(err: unknown, keyCount: number): void;
};

/** The script's reply cannot be trusted for these keys. Always safe to re-read key by key. */
export class UnusableReplyError extends Error {}

function isNoScript(err: unknown) {
  return err instanceof Error && err.message.startsWith('NOSCRIPT');
}

async function runScript<V>(
  keys: string[],
  node: string,
  deps: BatchedGetDeps<V>
): Promise<(V | null)[]> {
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
  if (!Array.isArray(reply) || reply.length !== keys.length + 1) {
    throw new UnusableReplyError(
      `node-local GET returned ${Array.isArray(reply) ? reply.length : typeof reply} entries for ${
        keys.length
      } keys`
    );
  }
  const last = reply[keys.length];
  const ranOn = Buffer.isBuffer(last) ? last.toString('utf8') : last;
  if (ranOn !== node) {
    throw new UnusableReplyError(`node-local GET ran on ${String(ranOn)}, expected ${node}`);
  }
  // The id proves WHERE the script ran, not that it ran without ASKING. A MOVED then an ASK can
  // land it back on the expected node with ASKING (the slot left and is coming back). Any MOVED
  // makes the client re-read its slot map, so a map that no longer names this node for the first
  // key means the script was redirected on the way: discard the reply.
  if (deps.nodeOf(calculateSlot(keys[0])) !== node) {
    throw new UnusableReplyError(`slot map moved while the node-local GET ran on ${node}`);
  }
  return reply.slice(0, keys.length).map((v) => {
    if (v === null || v === undefined) return null;
    if (!deps.isValue(v)) throw new UnusableReplyError(`node-local GET returned a ${typeof v}`);
    return v;
  });
}

/**
 * Returns a getter with the same contract as `Promise.all(keys.map(get))`: one entry per key, in
 * order, null for a missing key. It rejects when a key could not be read — by the script on a
 * transport failure, or by a plain GET.
 */
export function createBatchedGet<V>(
  deps: BatchedGetDeps<V>,
  { cooldownMs = NODE_LOCAL_GET_FALLBACK_COOLDOWN_MS, now = () => performance.now() } = {}
) {
  let scriptPausedUntil = 0;
  const perKey = (keys: string[]) => Promise.all(keys.map((k) => deps.get(k)));

  return async function batchedGet(keys: string[]): Promise<(V | null)[]> {
    if (keys.length <= 1 || now() < scriptPausedUntil) return perKey(keys);

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

    const parts: { node?: string; idx: number[] }[] = ungrouped.map((i) => ({ idx: [i] }));
    for (const [node, group] of groups) {
      for (let s = 0; s < group.length; s += NODE_LOCAL_GET_MAX_KEYS)
        parts.push({ node, idx: group.slice(s, s + NODE_LOCAL_GET_MAX_KEYS) });
    }

    const out: (V | null)[] = new Array(keys.length).fill(null);
    await Promise.all(
      parts.map(async ({ node, idx: part }) => {
        const partKeys = part.map((i) => keys[i]);
        let values: (V | null)[];
        if (partKeys.length === 1 || node === undefined) {
          values = await perKey(partKeys);
        } else {
          try {
            values = await runScript(partKeys, node, deps);
          } catch (err) {
            if (!(err instanceof UnusableReplyError) && !deps.isServerError(err)) throw err;
            // Log once per cooldown, not once per failed group per call.
            if (now() >= scriptPausedUntil) deps.onFallback?.(err, partKeys.length);
            scriptPausedUntil = now() + cooldownMs;
            values = await perKey(partKeys);
          }
        }
        for (let j = 0; j < part.length; j++) out[part[j]] = values[j];
      })
    );
    return out;
  };
}

/** The slice of a node-redis cluster client (in Buffer type-mapping) the getter needs. */
type BufferClusterClient = {
  get(key: string): Promise<unknown>;
  evalSha(sha: string, args: ScriptArgs): Promise<unknown>;
  eval(script: string, args: ScriptArgs): Promise<unknown>;
};

/**
 * The getter wired to a node-redis CLUSTER client: `bufferClient` issues the commands (so they go
 * through the same instrumented `_execute` as every other command), and `cluster` — the cluster
 * object itself — supplies the slot map used for grouping.
 *
 * The slot map is read from `cluster.slots`, a node-redis property. If it is ever missing (a
 * client upgrade), every key is read with a plain GET — the behaviour before this module — and
 * that is logged once rather than silently losing the batching.
 */
export function createClusterBufferGet(
  bufferClient: BufferClusterClient,
  cluster: { slots?: unknown },
  log: (msg: string) => void,
  options?: { cooldownMs?: number; now?: () => number }
) {
  let warnedNoSlotMap = false;
  return createBatchedGet<Buffer>(
    {
      get: async (key) => {
        const v = await bufferClient.get(key);
        return v === null || v === undefined ? null : (v as Buffer);
      },
      evalSha: (sha, args) => bufferClient.evalSha(sha, args),
      eval: (script, args) => bufferClient.eval(script, args),
      nodeOf: (slot) => {
        const slots = cluster.slots;
        if (!Array.isArray(slots)) {
          if (!warnedNoSlotMap) {
            warnedNoSlotMap = true;
            log(
              'Batched cluster GET: no readable slot map on the cluster client; using per-key GETs'
            );
          }
          return undefined;
        }
        const id = slots[slot]?.master?.id;
        return typeof id === 'string' && id.length > 0 ? id : undefined;
      },
      isValue: (v): v is Buffer => Buffer.isBuffer(v),
      isServerError: (err) => err instanceof ErrorReply,
      onFallback: (err, keyCount) =>
        log(
          `Batched cluster GET fell back to per-key GETs for ${keyCount} keys (pausing the script for a cooldown): ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
    },
    options
  );
}

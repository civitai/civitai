// Pipelined multi-key GET for the cache CLUSTER client: one pipelined write per owning master
// instead of one routed GET per key.
//
// WHY: a plain MGET across keys in different hash slots fails with CROSSSLOT, so `packed.mGet` used
// to issue one GET per key through the cluster router, and per-id caches (createCachedArray) read
// up to 200 keys per call. Most of that cost is client-side, per routed command. Here the keys are
// grouped by the master that owns their slot and each group's GETs are written to that node's
// connection together, outside the router.
//
// Keys, values and server-side work are unchanged — the server sees the same GETs. No script, no
// minimum server version, no migration.
//
// SAFETY: these GETs go straight to one node and are NOT redirected. A plain GET (no ASKING) on a
// node is authoritative or an error: the node answers with the value, or nil only for a key in a
// slot it serves that is absent; a key it does not serve, a key in a slot it is importing, and an
// absent key in a slot it is migrating away all answer MOVED/ASK. So a stale slot map or a
// migration can only produce MOVED/ASK replies, never a wrong value or a false miss. Each key whose
// reply is MOVED or ASK is re-read on its own through the normal routed GET, which follows them.
// ANY OTHER failure — another error reply (LOADING, CLUSTERDOWN, TRYAGAIN, OOM, …) or a transport
// failure (deadline, closed or reconnecting connection) — rejects the call, as a failed GET did
// before. Those mean the node itself is struggling, and re-reading key by key would only send it
// N more commands.
//
// The batch bypasses the router's per-command instrumentation, so `track` must account it as
// `keys.length` commands (see trackClusterCommands in ./client).
import calculateSlot from 'cluster-key-slot';
import { ErrorReply } from 'redis';

export type PipelinedGetDeps<V> = {
  /** A single routed GET (follows MOVED/ASK, instrumented as usual). */
  get(key: string): Promise<V | null>;
  /**
   * Identity of the master the client currently believes owns `slot`, or undefined when the slot
   * map does not know it. Only used to GROUP keys; a wrong answer costs a re-read, never a value.
   */
  nodeOf(slot: number): string | undefined;
  /**
   * Send a GET for every key to `node` in one write, without following redirects. One promise
   * per key: a key's reply error rejects only its own promise. Throws (or the returned promise
   * rejects) when the node cannot be reached at all.
   */
  pipelineGet(node: string, keys: string[]): Promise<PromiseSettledResult<unknown>[]>;
  /** Account `count` commands in the wedge instrumentation while `run` is in flight. */
  track<T>(count: number, run: () => Promise<T>): Promise<T>;
  /** True when a reply is a usable value (e.g. a Buffer for the buffer client). */
  isValue(v: unknown): v is V;
  /** True for a MOVED or ASK error reply — the only failures a routed re-read can fix. */
  isRedirect(err: unknown): boolean;
  /** Called once per batch that had to re-read some keys on their own. */
  onReread?(keyCount: number, firstError: unknown): void;
};

/**
 * Returns a getter with the same contract as `Promise.all(keys.map(get))`: one entry per key, in
 * order, null for a missing key. It rejects when a key could not be read.
 */
export function createPipelinedGet<V>(deps: PipelinedGetDeps<V>) {
  const perKey = (keys: string[]) => Promise.all(keys.map((k) => deps.get(k)));

  return async function pipelinedGet(keys: string[]): Promise<(V | null)[]> {
    if (keys.length <= 1) return perKey(keys);

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

    const out: (V | null)[] = new Array(keys.length).fill(null);
    const reread: number[] = [...ungrouped];
    let firstError: unknown;

    await Promise.all(
      [...groups].map(async ([node, idx]) => {
        if (idx.length === 1) {
          reread.push(idx[0]);
          return;
        }
        const groupKeys = idx.map((i) => keys[i]);
        const settled = await deps.track(groupKeys.length, () => deps.pipelineGet(node, groupKeys));
        if (settled.length !== groupKeys.length) {
          throw new Error(
            `pipelined GET returned ${settled.length} replies for ${groupKeys.length} keys`
          );
        }
        for (let j = 0; j < idx.length; j++) {
          const r = settled[j];
          if (r.status === 'fulfilled') {
            const v = r.value;
            if (v === null || v === undefined) out[idx[j]] = null;
            else if (deps.isValue(v)) out[idx[j]] = v;
            else {
              // Not a value we can decode: re-read rather than guess.
              firstError ??= new Error(`pipelined GET returned a ${typeof v}`);
              reread.push(idx[j]);
            }
          } else if (deps.isRedirect(r.reason)) {
            // MOVED/ASK: this key alone takes the routed path, which follows the redirect.
            firstError ??= r.reason;
            reread.push(idx[j]);
          } else {
            // Any other error reply, or a transport failure: the node is unreachable, stuck or
            // refusing reads. Reject, as a failed GET did; never re-ask it key by key.
            throw r.reason;
          }
        }
      })
    );

    if (reread.length > 0) {
      if (firstError !== undefined) deps.onReread?.(reread.length, firstError);
      const values = await perKey(reread.map((i) => keys[i]));
      for (let j = 0; j < reread.length; j++) out[reread[j]] = values[j];
    }
    return out;
  };
}

/** The slice of a node-redis cluster client the getter needs. */
type ClusterLike = {
  slots?: unknown;
  nodeClient(node: unknown): unknown;
};

type NodeClientLike = {
  sendCommand(
    args: string[],
    options?: { typeMapping?: Record<number, unknown>; timeout?: number }
  ): Promise<unknown>;
};

/**
 * The getter wired to a node-redis CLUSTER client. `get` is the routed buffer-mode GET; `cluster`
 * supplies the slot map (`cluster.slots[slot].master`, a node-redis property) and the per-node
 * connections (`cluster.nodeClient(master)`); `typeMapping` makes replies Buffers; `track` is the
 * wedge instrumentation.
 *
 * If the slot map is ever missing (a client upgrade), every key is read with a plain GET — the
 * behaviour before this module — and that is logged once rather than silently losing the batching.
 */
export function createClusterPipelinedGet(opts: {
  get(key: string): Promise<unknown>;
  cluster: ClusterLike;
  typeMapping: Record<number, unknown>;
  track<T>(count: number, run: () => Promise<T>): Promise<T>;
  log(msg: string): void;
}) {
  const { cluster, typeMapping, log } = opts;
  let warnedNoSlotMap = false;
  // Group key (address) → the master node object last seen at that address in the slot map.
  // Updated on every lookup and never cleared, so concurrent calls cannot race on it.
  const masters = new Map<string, unknown>();

  return createPipelinedGet<Buffer>({
    get: async (key) => {
      const v = await opts.get(key);
      return v === null || v === undefined ? null : (v as Buffer);
    },
    nodeOf: (slot) => {
      const slots = cluster.slots;
      if (!Array.isArray(slots)) {
        if (!warnedNoSlotMap) {
          warnedNoSlotMap = true;
          log(
            'Pipelined cluster GET: no readable slot map on the cluster client; using per-key GETs'
          );
        }
        return undefined;
      }
      const master = slots[slot]?.master;
      const address = master?.address;
      if (typeof address !== 'string') return undefined;
      masters.set(address, master);
      return address;
    },
    pipelineGet: async (node, keys) => {
      // Read in the same synchronous run as the grouping (`track` calls this without awaiting
      // first), so the node object is the one the slot map named for these keys. Do not add an
      // await before this line.
      const master = masters.get(node);
      const client = (await cluster.nodeClient(master)) as NodeClientLike;
      // Issued in one tick: node-redis writes them to the socket together. `timeout: undefined`:
      // a node connection's own default is node-redis 6's 5 s command timeout (the cluster's
      // commandOptions reach only routed commands), and `track` holds the deadline.
      return Promise.allSettled(
        keys.map((k) => client.sendCommand(['GET', k], { typeMapping, timeout: undefined }))
      );
    },
    track: opts.track,
    isValue: (v): v is Buffer => Buffer.isBuffer(v),
    isRedirect: (err) => err instanceof ErrorReply && /^(MOVED|ASK) /.test(err.message),
    onReread: (keyCount, err) =>
      log(
        `Pipelined cluster GET re-read ${keyCount} keys on their own: ${
          err instanceof Error ? err.message : String(err)
        }`
      ),
  });
}

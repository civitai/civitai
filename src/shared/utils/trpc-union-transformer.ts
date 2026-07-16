import type { CombinedDataTransformer } from '@trpc/server';
import { parse as devalueParse, stringify as devalueStringify } from 'devalue';
import superjson from 'superjson';

/**
 * Format-sniffing UNION deserializer — the READ half of the phased
 * superjson → devalue tRPC transformer migration.
 *
 * The two serializers emit disjoint JS types, so no negotiation/versioning is
 * needed to tell them apart at decode time:
 *   - `superjson.serialize(x)` ALWAYS returns an OBJECT (`{ json, meta? }`).
 *   - `devalue.stringify(x)`   ALWAYS returns a STRING.
 * tRPC hands the transformer output straight back to `deserialize` after the
 * wire round-trip (a string stays a string, an object stays an object), so a
 * `typeof x === 'string'` sniff routes each payload to the correct decoder.
 *
 * `null`/`undefined`/absent input is NOT a string, so it falls to the superjson
 * branch — byte-for-byte the empty-input behavior from before the migration.
 *
 * This lets every reader (server-reading-input, client-reading-response, SSR
 * hydrate) accept EITHER format regardless of which serializer wrote the bytes.
 * The union READ is what makes the write-flip safe and reversible: a reader can
 * always decode a superjson payload written by a stale (pre-migration) peer AND
 * a devalue payload written by an up-to-date one. READ stays UNION on every slot
 * in Phase 2 — only the SERVER response write is (env-)flipped, never the read.
 */
export function unionDeserialize(object: unknown): any {
  return typeof object === 'string'
    ? devalueParse(object)
    : superjson.deserialize(object as any);
}

/**
 * The devalue write. Kept as a named export because it is the value the SERVER
 * write flips TO (see `serverWriteSerialize`) and it is the exact function the
 * non-POJO write-path guard test exercises: `devalue.stringify` is STRICT — it
 * THROWS on any value it can't faithfully represent (a returned `Error`, an SDK
 * class instance, a symbol/Promise), which is the invariant the paddle/buzz
 * write-path fixes in this PR restore. `devalue.stringify` always returns a
 * string; the union deserializer above routes that string back through
 * `devalue.parse` on read.
 */
export const writeSerialize = (object: any): string => devalueStringify(object);

/**
 * Pure selector for the SERVER response write format — extracted so the
 * env-gate's SELECTION logic is unit-testable without a module reload:
 *   - `false` (default) → `superjson.serialize` (object output). The wire is
 *     byte-for-byte what every pool wrote in Phase 1, so merging is zero-risk.
 *   - `true`            → `devalue.stringify` (string output). Only a pool whose
 *     Deployment sets `TRPC_WRITE_DEVALUE=true` writes devalue responses.
 * (superjson v2's default-export methods are pre-bound, so passing
 * `superjson.serialize` unbound is safe.)
 */
export function pickServerWriteSerialize(flag: boolean): (object: any) => any {
  return flag ? devalueStringify : superjson.serialize;
}

/**
 * Server-side write gate, read ONCE at module load. This is the ONLY place the
 * Phase-2 write format flips, and it flips PER POOL: a pool's Deployment sets
 * `TRPC_WRITE_DEVALUE=true` to make that pool (and ONLY that pool) write devalue
 * responses; every other pool keeps writing superjson. Rollback = unset the env
 * + restart the pod. Default (unset) = superjson everywhere = wire unchanged.
 *
 * Reads process.env directly (module-load constant) — the client bundle never
 * evaluates this branch because the client transformer never references it.
 */
export const WRITE_DEVALUE = process.env.TRPC_WRITE_DEVALUE === 'true';
export const serverWriteSerialize = pickServerWriteSerialize(WRITE_DEVALUE);

/**
 * Build a complete SERVER-SIDE `CombinedDataTransformer`: union sniffer on both
 * READ slots, and the env-gated `serverWriteSerialize` on the response WRITE
 * slot. The server (`src/server/trpc.ts`) overrides `output.serialize` with an
 * instrumentation-wrapped variant (it times the response serialize — the exact
 * frame that pegs the loop on an oversized response) whose inner call is STILL
 * `serverWriteSerialize`, so the write format stays single-sourced through the
 * gate. The SSR helper uses the default (`buildTransformer()`), so SSR dehydrate
 * flips only when ITS pool sets `TRPC_WRITE_DEVALUE`.
 *
 * `input.serialize` is set to `superjson.serialize` purely to make the object
 * complete — it is NEVER exercised server-side (the server only DESERIALIZES
 * request inputs; the CLIENT writes them). Both this and the client transformer
 * therefore read the union and are independent of the write gate.
 *
 * @param outputSerialize response-serialize override (server injects the
 *   instrumented wrapper). Defaults to the env-gated `serverWriteSerialize`.
 */
export function buildTransformer(
  outputSerialize: (object: any) => any = serverWriteSerialize
): CombinedDataTransformer {
  return {
    input: { serialize: superjson.serialize, deserialize: unionDeserialize },
    output: { serialize: outputSerialize, deserialize: unionDeserialize },
  };
}

/**
 * The SERVER-SIDE transformer used by the SSR helpers
 * (`src/server/utils/server-side-helpers.ts`): env-gated response WRITE (via
 * `serverWriteSerialize`), union READ. The server proper builds its own via
 * `buildTransformer(instrumentedSerialize)` in `src/server/trpc.ts` — the only
 * legitimate server-specific difference is the instrumented `output.serialize`.
 */
export const unionTransformer: CombinedDataTransformer = buildTransformer();

/**
 * The CLIENT (browser) transformer: superjson WRITE, union READ.
 *
 * The browser bundle is one-size-fits-all — it can't be per-pool gated — so the
 * client always WRITES superjson request inputs (unchanged from Phase 1). The
 * server union-READS those inputs, so the client does NOT need to write devalue
 * for the per-pool server canary. `output.deserialize` stays the UNION sniffer,
 * so the client decodes BOTH a superjson response (from an un-flipped pool) and
 * a devalue response (from a `TRPC_WRITE_DEVALUE=true` pool) transparently.
 *
 * `output.serialize` is set to `superjson.serialize` only to complete the
 * object — the client never serializes a response.
 */
export const clientTransformer: CombinedDataTransformer = {
  input: { serialize: superjson.serialize, deserialize: unionDeserialize },
  output: { serialize: superjson.serialize, deserialize: unionDeserialize },
};

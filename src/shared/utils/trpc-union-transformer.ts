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
  return typeof object === 'string' ? devalueParse(object) : superjson.deserialize(object as any);
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
 * Observer for devalue-write fallbacks. The shared module can't import server
 * logging (this file is in the client bundle), so the server registers a
 * listener at init (src/server/trpc.ts) that attributes the offending
 * procedure via the serialize ALS ctx and ships it to Axiom.
 */
let devalueFallbackObserver: ((error: unknown) => void) | undefined;
export function onDevalueWriteFallback(observer: (error: unknown) => void): void {
  devalueFallbackObserver = observer;
}

/**
 * FAIL-OPEN devalue write: try devalue, and on a strict-mode throw (a non-POJO
 * in the payload — a returned Error, an SDK class instance, a Prisma Decimal)
 * fall back to superjson for THAT response and notify the observer.
 *
 * Rationale: the prod flip (#3135) surfaced latent non-POJO write paths as
 * hard 500s (e.g. /changelog SSR, model-version Decimal). devalue's strictness
 * is the right long-term contract, but enforcement belongs in tests + telemetry,
 * not user-facing failures: every reader is the format-sniffing UNION, so a
 * per-response superjson fallback decodes identically on every client. The
 * observer gives us the exact offender list to fix before Phase 3 goes strict.
 */
export const writeSerializeWithFallback = (object: any): unknown => {
  try {
    return devalueStringify(object);
  } catch (error) {
    try {
      devalueFallbackObserver?.(error);
    } catch {
      // observer failures must never affect the response path
    }
    return superjson.serialize(object);
  }
};

/**
 * Pure selector for the SERVER response write format — extracted so the
 * env-gate's SELECTION logic is unit-testable without a module reload:
 *   - `false` (default) → `superjson.serialize` (object output). The wire is
 *     byte-for-byte what every pool wrote in Phase 1, so merging is zero-risk.
 *   - `true`            → `writeSerializeWithFallback` (devalue string output,
 *     with a per-response superjson fallback on non-POJO payloads — see above).
 *     Only a pool whose Deployment sets `TRPC_WRITE_DEVALUE=true` writes devalue.
 * (superjson v2's default-export methods are pre-bound, so passing
 * `superjson.serialize` unbound is safe.)
 */
export function pickServerWriteSerialize(flag: boolean): (object: any) => any {
  return flag ? writeSerializeWithFallback : superjson.serialize;
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
 * The CLIENT (browser) transformer: devalue WRITE (inputs), union READ.
 *
 * Phase 3 (safe slice): `input.serialize` is `writeSerialize` (devalue), so the
 * client WRITES request inputs as devalue strings. This is UNGATED and cannot
 * break a stale peer: the SERVER's `input.deserialize` is the UNION sniffer, so
 * it reads devalue inputs from updated clients AND superjson inputs from stale
 * clients — both decode. The server therefore pays the cheaper `devalue.parse`
 * on inputs as clients update, and request bodies get slightly smaller. No env
 * gate is needed because the read side already accepts either format.
 *
 * `output.deserialize` stays the UNION sniffer (UNCHANGED), so the client still
 * decodes BOTH a superjson response (from an un-flipped pool) and a devalue
 * response (from a `TRPC_WRITE_DEVALUE=true` pool) transparently. superjson stays
 * imported and available on the read path for that backward-compat + rollback.
 *
 * `output.serialize` is left as `superjson.serialize` only to complete the
 * object — the client never serializes a response, so it is never exercised
 * (minimal change; harmless either way).
 */
export const clientTransformer: CombinedDataTransformer = {
  // FAIL-OPEN input write (mirrors the server's `writeSerializeWithFallback`,
  // #3186): a non-POJO input (a class instance / Decimal / Error smuggled into
  // an input) degrades to superjson for THAT request — which the server
  // union-reads identically — instead of throwing strict-devalue in the browser
  // and hard-failing the query (ungated, 100% of updated clients). Enforcement
  // belongs in tests + telemetry, not user-facing failures.
  input: { serialize: writeSerializeWithFallback, deserialize: unionDeserialize },
  output: { serialize: superjson.serialize, deserialize: unionDeserialize },
};

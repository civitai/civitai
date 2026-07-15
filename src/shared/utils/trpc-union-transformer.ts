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
 * a devalue payload written by an up-to-date one.
 */
export function unionDeserialize(object: unknown): any {
  return typeof object === 'string'
    ? devalueParse(object)
    : superjson.deserialize(object as any);
}

/**
 * The single source of truth for the WRITE format. Phase 2 flips every write
 * slot (client request-serialize, server response-serialize, SSR dehydrate) to
 * devalue by pointing them all at THIS function — so the format can never be
 * flipped in one place and missed in another. A later phase changes only this
 * one function (and the union can then be dropped once no peer writes superjson).
 *
 * `devalue.stringify` always returns a string; the union deserializer above
 * routes that string back through `devalue.parse` on read.
 */
export const writeSerialize = (object: any): string => devalueStringify(object);

/**
 * Build a complete `CombinedDataTransformer` with the union sniffer on both READ
 * slots and `writeSerialize` (devalue) on both WRITE slots. The server overrides
 * `output.serialize` with an instrumentation-wrapped variant (it times the
 * response serialize — the exact frame that pegs the loop on an oversized
 * response) whose inner call is STILL `writeSerialize`, so the wire format stays
 * single-sourced. Every other WRITE/READ slot is identical across client, SSR
 * and server, which is why they share this factory.
 *
 * @param outputSerialize response-serialize override (server injects the
 *   instrumented wrapper). Defaults to the plain `writeSerialize` used by the
 *   client links and SSR helpers.
 */
export function buildTransformer(
  outputSerialize: (object: any) => any = writeSerialize
): CombinedDataTransformer {
  return {
    input: { serialize: writeSerialize, deserialize: unionDeserialize },
    output: { serialize: outputSerialize, deserialize: unionDeserialize },
  };
}

/**
 * The client/SSR transformer: devalue WRITE (via `writeSerialize`), union READ.
 * Shared by the client tRPC links (`src/utils/trpc.ts`) and the SSR helpers
 * (`src/server/utils/server-side-helpers.ts`). The server builds its own via
 * `buildTransformer(instrumentedSerialize)` in `src/server/trpc.ts` — the only
 * legitimate server-specific difference is the instrumented `output.serialize`.
 */
export const unionTransformer: CombinedDataTransformer = buildTransformer();

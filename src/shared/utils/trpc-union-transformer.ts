import type { CombinedDataTransformer } from '@trpc/server';
import { parse as devalueParse } from 'devalue';
import superjson from 'superjson';

/**
 * Format-sniffing UNION deserializer — the first (additive) step of the phased
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
 * branch — byte-for-byte today's behavior for empty inputs.
 *
 * This lets every reader (server-reading-input, client-reading-response, SSR
 * hydrate) accept EITHER format regardless of which serializer wrote the bytes.
 * In Phase 1 nothing writes devalue yet (all `serialize` slots stay superjson),
 * so the wire is 100% unchanged; teaching readers both formats first is what
 * makes a later write-flip safe and reversible.
 */
export function unionDeserialize(object: unknown): any {
  return typeof object === 'string'
    ? devalueParse(object)
    : superjson.deserialize(object as any);
}

/**
 * superjson serialize wrapped so `this` is preserved when tRPC invokes it as a
 * bare `transformer.input.serialize(x)` (the superjson default export is a class
 * instance whose methods read `this`). Phase 1 keeps every WRITE on superjson —
 * the wire format is unchanged.
 */
const superjsonSerialize = (object: any) => superjson.serialize(object);

/**
 * The Phase-1 client/SSR transformer: WRITE stays superjson, READ is the union
 * sniffer. Shared by the client tRPC links (`src/utils/trpc.ts`) and the SSR
 * helpers (`src/server/utils/server-side-helpers.ts`). The server transformer is
 * built inline in `src/server/trpc.ts` instead, because its `output.serialize`
 * keeps the serialize-timing instrumentation wrapper.
 *
 * All four slots are filled so the object is a complete `CombinedDataTransformer`
 * (both `input` and `output` require `serialize` + `deserialize`); the slots a
 * given side never exercises are harmless.
 */
export const unionTransformer: CombinedDataTransformer = {
  input: { serialize: superjsonSerialize, deserialize: unionDeserialize },
  output: { serialize: superjsonSerialize, deserialize: unionDeserialize },
};

import { parse, stringify } from 'devalue';

/**
 * tRPC wire transformer — devalue (replacing superjson).
 *
 * Single source of truth shared by all three tRPC sites so they can never drift:
 *   - server router       (src/server/trpc.ts) — wraps `serialize` in a span
 *   - client links + next  (src/utils/trpc.ts)
 *   - SSR helper           (src/server/utils/server-side-helpers.ts)
 *
 * tRPC calls `serialize` to turn a value into something JSON-embeddable, then
 * JSON.stringifies the whole response envelope itself. devalue.stringify returns
 * a STRING (its flattened, reference-deduped format), so tRPC's outer stringify
 * escapes it once — that double-encode is expected and still ~2x faster than
 * superjson (the prior transformer) on our feed payloads.
 *
 * Type coverage vs superjson: devalue natively handles Date, BigInt, Map, Set,
 * RegExp, undefined, NaN/Infinity, and cyclic/repeated references. The one
 * behavioral difference is that devalue THROWS on non-POJO class instances
 * (e.g. a Prisma `Decimal`) where superjson silently degraded them — this repo
 * has no Decimal columns and no client-facing class instances, and the loud
 * failure mode makes a canary rollout safe (a missed procedure is a logged 500,
 * not silent corruption).
 */
export const trpcTransformer = {
  serialize: (object: unknown): string => stringify(object),
  deserialize: (object: unknown): unknown => parse(object as string),
};

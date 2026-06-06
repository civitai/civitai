import { parse, stringify } from 'devalue';

// Isomorphic tRPC data transformer (client + server MUST use this exact object).
//
// Replaces superjson with devalue: ~2.7x faster serialize / ~13x faster
// deserialize on the Date-heavy feed payloads (superjson's plainer.js walker was
// ~10% of busy main-thread CPU in a prod pin profile). devalue natively handles
// Date, Map, Set, BigInt, RegExp, undefined, and repeated/circular references.
//
// ⚠️ devalue is STRICT: it THROWS on values it doesn't recognize — notably
// non-builtin class instances (Prisma Decimal, dayjs objects, custom classes).
// superjson silently coerced those to plain objects (lossy). Any tRPC procedure
// that returns such a value must be changed to return a POJO/number/Date before
// this can ship. This is the migration's main risk — see PR notes.
export const trpcTransformer = {
  serialize: (object: unknown) => stringify(object),
  // devalue.parse() requires a string (it JSON.parses internally). tRPC hands
  // deserialize a non-string when there's no serialized input to decode — e.g.
  // a GET to a mutation with no `?input=`, or a no-input procedure — passing an
  // empty object `{}`, which would become JSON.parse("[object Object]") → a
  // bogus BAD_REQUEST. superjson tolerated this; devalue is strict. Only parse
  // real (string) payloads; pass non-strings through so downstream zod handles
  // absent/empty input normally.
  deserialize: (object: unknown) => (typeof object === 'string' ? parse(object) : object),
};

import { parse as devalueParse, stringify as devalueStringify } from 'devalue';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import {
  buildTransformer,
  clientTransformer,
  onDevalueWriteFallback,
  pickServerWriteSerialize,
  serverWriteSerialize,
  unionDeserialize,
  unionTransformer,
  WRITE_DEVALUE,
  writeSerialize,
  writeSerializeWithFallback,
} from '~/shared/utils/trpc-union-transformer';

/**
 * Phase 2 of the superjson → devalue tRPC transformer migration env-gates ONLY
 * the SERVER response write (`TRPC_WRITE_DEVALUE`, per-pool) while:
 *   - READ stays the format-sniffing UNION on EVERY slot (server input-read,
 *     client response-read, SSR hydrate), so a payload written by EITHER
 *     serializer decodes regardless of which peer wrote it.
 *   - the CLIENT always WRITES superjson (the browser bundle can't be per-pool
 *     gated; the server union-reads its inputs anyway).
 *   - the SERVER write is `serverWriteSerialize` = superjson by DEFAULT (flag
 *     unset → wire byte-identical to Phase 1) and devalue only when the pool
 *     sets `TRPC_WRITE_DEVALUE=true`.
 * The tests exercise the pure SELECTION logic (`pickServerWriteSerialize`) for
 * both gate branches rather than reloading the module, plus the union-read
 * backward compat and the strict non-POJO devalue-write guard.
 * Pure (no DB/Prisma), so it runs locally.
 */

// A representative payload mixing the rich types the feed handlers emit.
const sample = () => ({
  // top-level BigInt cursor (model.service.ts nextCursor: string | bigint)
  nextCursor: 9007199254740993n,
  items: [
    {
      id: 1,
      name: 'alpha',
      createdAt: new Date('2024-01-02T03:04:05.678Z'),
      publishedAt: new Date('2023-12-31T23:59:59.000Z'),
      // optional/nullable field present as undefined
      description: undefined as string | undefined,
      tags: ['a', 'b', 'c'],
      stats: { downloadCount: 10, thumbsUpCount: 5, ratio: 0.5 },
      nested: { user: { id: 7, joinedAt: new Date('2020-06-01T00:00:00.000Z') } },
    },
    {
      id: 2,
      name: 'beta',
      createdAt: new Date('2025-07-14T12:00:00.000Z'),
      tags: [] as string[],
      stats: { downloadCount: 0, thumbsUpCount: 0, ratio: 0 },
    },
  ],
  // Map round-trips through both serializers
  buckets: new Map<string, number>([
    ['x', 1],
    ['y', 2],
  ]),
});

describe('unionDeserialize (READ stays union on every slot in Phase 2)', () => {
  it('round-trips a devalue-WRITTEN payload (string shape → devalue branch)', () => {
    const x = sample();
    const written = devalueStringify(x); // ALWAYS a string
    expect(typeof written).toBe('string');
    expect(unionDeserialize(written)).toEqual(x);
  });

  it('round-trips a superjson-WRITTEN payload (object shape → superjson branch)', () => {
    const x = sample();
    const written = superjson.serialize(x); // ALWAYS an object { json, meta? }
    expect(typeof written).not.toBe('string');
    expect(unionDeserialize(written)).toEqual(x);
  });

  it('preserves exact rich-type identities through both writers', () => {
    const x = sample();
    for (const written of [superjson.serialize(x), devalueStringify(x)]) {
      const out = unionDeserialize(written) as ReturnType<typeof sample>;
      expect(out.nextCursor).toBe(9007199254740993n);
      expect(typeof out.nextCursor).toBe('bigint');
      expect(out.items[0].createdAt).toBeInstanceOf(Date);
      expect(out.items[0].createdAt.getTime()).toBe(x.items[0].createdAt.getTime());
      expect(out.buckets).toBeInstanceOf(Map);
      expect(out.buckets.get('y')).toBe(2);
      // an explicitly-undefined field stays a present-but-undefined key
      expect('description' in out.items[0]).toBe(true);
      expect(out.items[0].description).toBeUndefined();
    }
  });

  it('falls to the superjson branch for null/undefined input (empty-input behavior)', () => {
    // superjson.deserialize of an empty-ish payload — not a string, so it must
    // NOT hit devalue.parse (which would throw on null). Matches how tRPC hands
    // back an absent/empty transformer payload.
    expect(unionDeserialize(superjson.serialize(undefined))).toBeUndefined();
    expect(unionDeserialize(superjson.serialize(null))).toBeNull();
  });
});

/**
 * Regression: the all-mutations "input deserializes to undefined" 500 incident.
 *
 * On the Next.js **pages-router** adapter a devalue INPUT delivered in the POST
 * BODY is JSON-parsed TWICE before it reaches `unionDeserialize` — the single
 * JSON-string quoting that `@trpc/client`'s `getBody` puts around the devalue
 * payload is stripped by (1) Next's `bodyParser` and (2) tRPC's `createBody`
 * `typeof req.body === 'string'` short-circuit — so tRPC's `req.json()` parses
 * the devalue string itself (a JSON array) into an ARRAY. That defeated the
 * `typeof === 'string'` sniff, `superjson.deserialize(array)` returned undefined,
 * and every non-batched mutation (generateFromGraph, track.*, reaction.toggle …)
 * 500'd. Superjson inputs never hit this — their `{ json, meta }` OBJECT survives
 * `createBody`'s re-`JSON.stringify`. This models that exact double-parse.
 */
function pagesRouterPostBodyDoubleParse(clientSerialized: unknown): unknown {
  // @trpc/client getBody: the transformer output is JSON.stringify'd once.
  const wireBody = JSON.stringify(clientSerialized);
  // Next.js bodyParser (application/json) parses the raw body → req.body.
  const reqBody = JSON.parse(wireBody);
  // @trpc/server node-http createBody: a STRING req.body is returned as-is (NOT
  // re-quoted); a non-string is re-JSON.stringify'd.
  const fetchBody = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
  // @trpc/server resolveResponse getInputs (non-batch): result[0] = req.json().
  return JSON.parse(fetchBody);
}

describe('unionDeserialize — pages-router POST-body double-parse recovery (mutations 500 incident)', () => {
  it('recovers a devalue INPUT that the pages adapter double-parsed into an array (was → undefined)', () => {
    const x = sample();
    // What a devalue-writing (e.g. cached #3178) client sends as the input.
    const clientSerialized = devalueStringify(x);
    const afterDoubleParse = pagesRouterPostBodyDoubleParse(clientSerialized);

    // Precondition: the double-parse HAS destroyed the string-ness (this is the bug).
    expect(typeof afterDoubleParse).not.toBe('string');
    expect(Array.isArray(afterDoubleParse)).toBe(true);

    // The fix recovers the full value (pre-fix this returned `undefined`).
    const out = unionDeserialize(afterDoubleParse) as ReturnType<typeof sample>;
    expect(out).not.toBeUndefined();
    expect(out).toEqual(x);
    expect(out.nextCursor).toBe(9007199254740993n);
    expect(out.buckets).toBeInstanceOf(Map);
    expect(out.items[0].createdAt).toBeInstanceOf(Date);
  });

  it('recovers the generateFromGraph mutation input shape (would 500 on the {input} destructure)', () => {
    const gfg = {
      input: { workflow: 'txt2img', prompt: 'a cat', disablePoi: false },
      tags: ['new'],
      civitaiTip: 0,
      creatorTip: 0,
      buzzType: 'blue',
      externalId: 'abc',
    };
    const out = unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(gfg)));
    expect(out).toEqual(gfg);
    // The resolver does `const { input } = input` — must not be undefined.
    expect(out.input.workflow).toBe('txt2img');
  });

  it('recovers a double-parsed devalue PRIMITIVE / bare-array input', () => {
    for (const x of [42, 'plain', true, [1, 2, 3], { a: 1 }]) {
      expect(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(x)))).toEqual(x);
    }
  });

  // Contract pin #1: devalue encodes these as BARE negative-int markers
  // (undefined→-1, NaN→-3, Infinity→-4, -Infinity→-5, -0→-6), so after the
  // double-parse they arrive as bare NUMBERS, not arrays. They must not collide
  // with isSuperjsonEnvelope and must round-trip losslessly. Guards the
  // "devalue top-level is array-or-negative-number" contract the fix rests on.
  it('recovers double-parsed devalue SPECIAL primitives (bare marker numbers)', () => {
    expect(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(undefined)))).toBeUndefined();
    expect(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(NaN)))).toBeNaN();
    expect(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(Infinity)))).toBe(Infinity);
    expect(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(-Infinity)))).toBe(-Infinity);
    // -0 must survive as -0 (devalue emits the -6 marker, not a raw -0).
    expect(Object.is(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(-0))), -0)).toBe(true);
  });

  // Contract pin #2: a user input literally shaped like a superjson envelope
  // ({ json, ... }) must NOT be mistaken for one. devalue flattens any top-level
  // object to an ARRAY, so isSuperjsonEnvelope never matches it. Guards the
  // "superjson-envelope sniff can't be spoofed by user data" contract.
  it('recovers a devalue input literally shaped like a { json, ... } superjson envelope', () => {
    for (const x of [{ json: 5 }, { json: 5, meta: 6 }, { json: { nested: true }, extra: 'x' }]) {
      expect(unionDeserialize(pagesRouterPostBodyDoubleParse(devalueStringify(x)))).toEqual(x);
    }
  });

  it('still routes a superjson envelope (its object survives createBody re-stringify) to superjson', () => {
    const x = sample();
    // Superjson path: createBody re-JSON.stringify's the object, so req.json()
    // yields the { json, meta } envelope intact — must NOT hit the devalue branch.
    const afterRoundTrip = pagesRouterPostBodyDoubleParse(superjson.serialize(x));
    expect(afterRoundTrip).not.toBeInstanceOf(Array);
    expect(unionDeserialize(afterRoundTrip)).toEqual(x);
  });
});

describe('serverWriteSerialize gate (TRPC_WRITE_DEVALUE, SERVER write only)', () => {
  it('default (flag unset in the test env) selects superjson — wire unchanged', () => {
    // The module read process.env.TRPC_WRITE_DEVALUE at load; it is unset here.
    expect(WRITE_DEVALUE).toBe(false);
    const x = sample();
    const out = serverWriteSerialize(x);
    // superjson output is an OBJECT, not a string — byte-identical to Phase 1.
    expect(typeof out).not.toBe('string');
    expect(out).toEqual(superjson.serialize(x));
    // and it still round-trips through the union read.
    expect(unionDeserialize(out)).toEqual(x);
  });

  it('pickServerWriteSerialize(false) → superjson OBJECT, decodable by superjson AND union', () => {
    const write = pickServerWriteSerialize(false);
    const x = sample();
    const out = write(x);
    expect(typeof out).not.toBe('string');
    expect(superjson.deserialize(out as any)).toEqual(x);
    expect(unionDeserialize(out)).toEqual(x);
  });

  it('pickServerWriteSerialize(true) → devalue STRING, decodable by devalue AND union', () => {
    const write = pickServerWriteSerialize(true);
    const x = sample();
    const out = write(x);
    expect(typeof out).toBe('string');
    expect(out).toBe(devalueStringify(x));
    expect(devalueParse(out as string)).toEqual(x);
    expect(unionDeserialize(out)).toEqual(x);
  });

  it('round-trips the rich types through BOTH gate selections', () => {
    const x = sample();
    for (const flag of [false, true]) {
      const out = unionDeserialize(pickServerWriteSerialize(flag)(x)) as ReturnType<typeof sample>;
      expect(out.nextCursor).toBe(9007199254740993n);
      expect(typeof out.nextCursor).toBe('bigint');
      expect(out.items[0].createdAt).toBeInstanceOf(Date);
      expect(out.buckets).toBeInstanceOf(Map);
      expect(out.buckets.get('y')).toBe(2);
      expect('description' in out.items[0]).toBe(true);
      expect(out.items[0].description).toBeUndefined();
    }
  });
});

describe('clientTransformer (browser: superjson WRITE, union READ)', () => {
  const x = { when: new Date('2024-01-01T00:00:00.000Z'), cursor: 42n };

  it('WRITES superjson (input.serialize output is an OBJECT, not a devalue string)', () => {
    const written = clientTransformer.input.serialize(x);
    expect(typeof written).not.toBe('string');
    expect(written).toEqual(superjson.serialize(x));
  });

  it('READS the union on output.deserialize (decodes BOTH a superjson and a devalue response)', () => {
    // an un-flipped pool responds superjson…
    expect(clientTransformer.output.deserialize(superjson.serialize(x))).toEqual(x);
    // …and a TRPC_WRITE_DEVALUE=true pool responds devalue — client decodes both.
    expect(clientTransformer.output.deserialize(devalueStringify(x))).toEqual(x);
    // input.deserialize is also union (unused on the client, but complete).
    expect(clientTransformer.input.deserialize(devalueStringify(x))).toEqual(x);
  });
});

describe('server transformer (unionTransformer + buildTransformer)', () => {
  const x = { when: new Date('2024-01-01T00:00:00.000Z'), cursor: 42n };

  it('unionTransformer (SSR/server default) WRITES via the env gate (superjson by default) and READS union', () => {
    // Default gate off → SSR dehydrate writes superjson (object), wire unchanged.
    const written = unionTransformer.output.serialize(x);
    expect(typeof written).not.toBe('string');
    expect(written).toEqual(superjson.serialize(x));
    // READ slots are the union sniffer — decode BOTH formats.
    expect(unionTransformer.output.deserialize(written)).toEqual(x);
    expect(unionTransformer.output.deserialize(devalueStringify(x))).toEqual(x);
    expect(unionTransformer.input.deserialize(devalueStringify(x))).toEqual(x);
  });

  it('buildTransformer honors an instrumentation-shaped output.serialize override; input.serialize is never exercised', () => {
    // The server proper passes an instrumented output.serialize whose wrappers are
    // pass-through (time/trace, then return serverWriteSerialize's result verbatim).
    // Model that with a wrapper that observes the call and returns the value verbatim.
    let wrapped = 0;
    const instrumentedSerialize = (data: any) => {
      wrapped++;
      return serverWriteSerialize(data); // == the env-gated write, single-sourced
    };
    const serverTransformer = buildTransformer(instrumentedSerialize);

    const written = serverTransformer.output.serialize(x);
    expect(wrapped).toBe(1);
    // matches the gate (superjson by default in this test env).
    expect(written).toEqual(serverWriteSerialize(x));

    // input.serialize is superjson-shaped (harmless; never used server-side).
    expect(typeof serverTransformer.input.serialize(x)).not.toBe('string');

    // READ: both slots are the union sniffer — devalue string AND legacy superjson.
    expect(serverTransformer.input.deserialize(devalueStringify(x))).toEqual(x);
    expect(serverTransformer.input.deserialize(superjson.serialize(x))).toEqual(x);
    expect(serverTransformer.output.deserialize(written)).toEqual(x);
  });
});

/**
 * The wire-output-must-be-a-POJO contract for the DEVALUE write path.
 *
 * superjson SILENTLY coerced non-POJO tRPC outputs (a returned `Error` → `{}`, an
 * SDK class instance → a stripped plain object), swallowing latent bugs. devalue
 * is strict: it THROWS on any value it can't faithfully represent, which turns
 * those same returns into a 500 the moment a pool's write path is devalue
 * (`TRPC_WRITE_DEVALUE=true`). This encodes that boundary so a future procedure
 * that returns a non-POJO (a raw `@paddle`/Stripe/AWS SDK entity, a caught
 * `Error`, a symbol-keyed object, a Promise) is caught here rather than in prod
 * when a pool flips. It is the invariant the paddle/buzz-withdrawal write-path
 * fixes in this PR restore. `writeSerialize` is exactly the devalue branch of the
 * gate (`pickServerWriteSerialize(true)`).
 *
 * NOTE: this guards the SERIALIZER choice, not every call site — grep can't find a
 * positionally-returned class instance. The real defense is mapping SDK results to
 * plain objects at the service boundary (see paddle.service `getAdjustmentsInfinite`).
 */
describe('devalue write path rejects non-POJO tRPC outputs (devalue is strict)', () => {
  class SdkEntity {
    readonly id = 'adj_123';
    readonly createdAt = '2024-01-01T00:00:00.000Z';
    constructor() {}
    // a method makes the prototype non-Object — exactly the Paddle `Adjustment` shape
    toJSON() {
      return { id: this.id };
    }
  }

  it('throws on a returned Error instance (the cancelSubscriptionPlan / buzz-withdrawal class)', () => {
    expect(() => writeSerialize(new Error('boom'))).toThrow();
    // nested in a response object is just as fatal
    expect(() => writeSerialize({ ok: false, error: new Error('boom') })).toThrow();
  });

  it('throws on an arbitrary class instance (the Paddle SDK `Adjustment` class)', () => {
    expect(() => writeSerialize(new SdkEntity())).toThrow();
    // the exact getAdjustmentsInfinite shape: { items: [<class instance>] }
    expect(() => writeSerialize({ items: [new SdkEntity()], nextCursor: undefined })).toThrow();
  });

  it('throws on symbol-keyed objects, symbol/function values, and Promises', () => {
    expect(() => writeSerialize({ [Symbol('k')]: 1 })).toThrow();
    expect(() => writeSerialize({ a: Symbol('v') })).toThrow();
    expect(() => writeSerialize({ fn: () => 1 })).toThrow();
    expect(() => writeSerialize(Promise.resolve(1))).toThrow();
  });

  it('ACCEPTS the POJO fix shape — mapping the SDK entity to a plain object round-trips', () => {
    // The fix: JSON round-trip (or an explicit map) turns the class instance into a
    // POJO. This is what `getAdjustmentsInfinite` now returns.
    const pojo = JSON.parse(JSON.stringify({ items: [new SdkEntity()], nextCursor: 'adj_9' }));
    const out = writeSerialize(pojo);
    expect(typeof out).toBe('string');
    expect(unionDeserialize(out)).toEqual(pojo);
  });

  it('still ACCEPTS the rich POJO types real handlers emit (Date/Map/Set/BigInt are fine)', () => {
    // devalue represents these faithfully — the contract rejects non-POJOs, NOT
    // these first-class rich types (so the fix is narrow: only class instances /
    // Errors / symbols / Promises are the hazard).
    expect(() =>
      writeSerialize({ d: new Date(), m: new Map([['a', 1]]), s: new Set([1]), n: 2n })
    ).not.toThrow();
  });
});

/**
 * FAIL-OPEN gate: `pickServerWriteSerialize(true)` routes through
 * `writeSerializeWithFallback`, which keeps devalue's strictness observable
 * (via the observer hook) without letting a non-POJO payload become a
 * user-facing 500 — the fallback superjson write decodes through the same
 * union READ every peer already runs. `writeSerialize` (above) stays the
 * strict contract for tests.
 */
describe('writeSerializeWithFallback (fail-open devalue write)', () => {
  it('writes devalue (string) for POJO payloads — identical to the strict write', () => {
    const x = sample();
    const out = writeSerializeWithFallback(x);
    expect(typeof out).toBe('string');
    expect(out).toBe(devalueStringify(x));
    expect(unionDeserialize(out)).toEqual(x);
  });

  it('falls back to superjson (object) on a non-POJO payload and notifies the observer', () => {
    const seen: unknown[] = [];
    onDevalueWriteFallback((err) => seen.push(err));
    try {
      const payload = { ok: false, error: new Error('boom') };
      const out = writeSerializeWithFallback(payload);
      // superjson object — NOT a devalue string — still union-decodable.
      expect(typeof out).not.toBe('string');
      expect(out).toEqual(superjson.serialize(payload));
      expect(unionDeserialize(out)).toEqual(
        superjson.deserialize(superjson.serialize(payload) as any)
      );
      expect(seen).toHaveLength(1);
    } finally {
      onDevalueWriteFallback(undefined as any);
    }
  });

  it('a throwing observer never breaks the response path', () => {
    onDevalueWriteFallback(() => {
      throw new Error('observer boom');
    });
    try {
      expect(() => writeSerializeWithFallback({ e: new Error('x') })).not.toThrow();
    } finally {
      onDevalueWriteFallback(undefined as any);
    }
  });

  it('pickServerWriteSerialize(true) IS the fail-open write (non-POJO → superjson, no throw)', () => {
    const write = pickServerWriteSerialize(true);
    const payload = {
      items: [
        new (class Sdk {
          id = 1;
          toJSON() {
            return { id: this.id };
          }
        })(),
      ],
    };
    let out: unknown;
    expect(() => (out = write(payload))).not.toThrow();
    expect(typeof out).not.toBe('string');
  });
});

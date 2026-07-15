import { stringify as devalueStringify } from 'devalue';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import {
  buildTransformer,
  unionDeserialize,
  unionTransformer,
  writeSerialize,
} from '~/shared/utils/trpc-union-transformer';

/**
 * Phase 2 of the superjson → devalue tRPC transformer migration flips every WRITE
 * slot to devalue while the READ slots stay the format-sniffing UNION. The tests
 * assert two contracts:
 *   1. UNION READ is version-agnostic — a devalue-WRITTEN payload AND a legacy
 *      superjson-WRITTEN payload BOTH round-trip through `unionDeserialize`. This
 *      backward-read compat is what makes the write-flip safe: a stale peer that
 *      still writes superjson is decoded fine, and rollback is one line.
 *   2. WRITE is now devalue — every serialize slot (`writeSerialize`, the shared
 *      `unionTransformer`, and a server-shaped `buildTransformer(...)`) emits a
 *      devalue string, not a superjson object.
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

describe('unionDeserialize (READ stays union in Phase 2)', () => {
  it('round-trips a devalue-WRITTEN payload (string shape → devalue branch)', () => {
    const x = sample();
    const written = devalueStringify(x); // ALWAYS a string
    expect(typeof written).toBe('string');
    expect(unionDeserialize(written)).toEqual(x);
  });

  it('STILL decodes a legacy superjson-WRITTEN payload (backward-read compat / rollback safety)', () => {
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

describe('WRITE is devalue in Phase 2', () => {
  const x = { when: new Date('2024-01-01T00:00:00.000Z'), cursor: 42n };

  it('writeSerialize is the single-sourced devalue write', () => {
    const out = writeSerialize(x);
    expect(typeof out).toBe('string');
    expect(out).toBe(devalueStringify(x));
    // and it round-trips through the union read
    expect(unionDeserialize(out)).toEqual(x);
  });

  it('unionTransformer (client/SSR) writes devalue strings and reads the union', () => {
    // WRITE slots: devalue STRING (not a superjson object).
    expect(typeof unionTransformer.input.serialize(x)).toBe('string');
    expect(typeof unionTransformer.output.serialize(x)).toBe('string');
    expect(unionTransformer.input.serialize(x)).toBe(devalueStringify(x));
    expect(unionTransformer.output.serialize(x)).toBe(devalueStringify(x));
    // READ slots: the union sniffer decodes BOTH formats.
    expect(unionTransformer.input.deserialize(devalueStringify(x))).toEqual(x);
    expect(unionTransformer.output.deserialize(superjson.serialize(x))).toEqual(x);
  });

  it('server transformer (buildTransformer with an instrumentation-shaped wrapper): serialize == devalue, deserialize == union', () => {
    // The server passes an instrumented output.serialize whose wrappers are
    // pass-through (they time/trace, then return writeSerialize's result verbatim).
    // Model that here with a wrapper that observes the call and returns the value
    // unchanged — the wire contract must be identical to plain devalue.
    let wrapped = 0;
    const instrumentedSerialize = (data: any) => {
      wrapped++;
      return writeSerialize(data); // == devalue string, single-sourced
    };
    const serverTransformer = buildTransformer(instrumentedSerialize);

    // WRITE: response-serialize is the instrumented devalue path; request-serialize
    // is the plain single-sourced devalue write.
    const written = serverTransformer.output.serialize(x);
    expect(wrapped).toBe(1);
    expect(typeof written).toBe('string');
    expect(written).toBe(devalueStringify(x));
    expect(serverTransformer.input.serialize(x)).toBe(devalueStringify(x));

    // READ: both slots are the union sniffer — devalue string AND legacy superjson.
    expect(serverTransformer.input.deserialize(devalueStringify(x))).toEqual(x);
    expect(serverTransformer.input.deserialize(superjson.serialize(x))).toEqual(x);
    expect(serverTransformer.output.deserialize(written)).toEqual(x);
  });
});

/**
 * The wire-output-must-be-a-POJO contract.
 *
 * superjson SILENTLY coerced non-POJO tRPC outputs (a returned `Error` → `{}`, an
 * SDK class instance → a stripped plain object), swallowing latent bugs. devalue
 * is strict: it THROWS on any value it can't faithfully represent, which turns
 * those same returns into a 500 the moment the write path is devalue. This encodes
 * that boundary so a future procedure that returns a non-POJO (a raw `@paddle`/
 * Stripe/AWS SDK entity, a caught `Error`, a symbol-keyed object, a Promise) is
 * caught here rather than in prod. It is the invariant the paddle/buzz-withdrawal
 * write-path fixes in this PR restore.
 *
 * NOTE: this guards the SERIALIZER choice, not every call site — grep can't find a
 * positionally-returned class instance. The real defense is mapping SDK results to
 * plain objects at the service boundary (see paddle.service `getAdjustmentsInfinite`).
 */
describe('write path rejects non-POJO tRPC outputs (devalue is strict)', () => {
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
    expect(() => writeSerialize({ d: new Date(), m: new Map([['a', 1]]), s: new Set([1]), n: 2n })).not.toThrow();
  });
});

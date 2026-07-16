import { stringify as devalueStringify } from 'devalue';
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { unionDeserialize, unionTransformer } from '~/shared/utils/trpc-union-transformer';

/**
 * Phase 1 of the superjson → devalue tRPC transformer migration adds a
 * format-sniffing UNION deserializer so every reader can decode BOTH formats
 * before any writer emits devalue (the wire stays superjson in Phase 1).
 *
 * The contract under test: `unionDeserialize(write(x))` deep-equals `x` for both
 * writers, across the non-POJO types that actually reach the transformer on the
 * response/request paths — Date, top-level BigInt (feed cursor), `undefined`
 * fields, nested arrays/objects, and Map. Pure (no DB/Prisma), so it runs locally.
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

describe('unionDeserialize', () => {
  it('round-trips a superjson-written payload (object shape → superjson branch)', () => {
    const x = sample();
    const written = superjson.serialize(x); // ALWAYS an object { json, meta? }
    expect(typeof written).not.toBe('string');
    expect(unionDeserialize(written)).toEqual(x);
  });

  it('round-trips a devalue-written payload (string shape → devalue branch)', () => {
    const x = sample();
    const written = devalueStringify(x); // ALWAYS a string
    expect(typeof written).toBe('string');
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

  it('falls to the superjson branch for null/undefined input (today’s behavior)', () => {
    // superjson.deserialize of an empty-ish payload — not a string, so it must
    // NOT hit devalue.parse (which would throw on null). Matches how tRPC hands
    // back an absent/empty transformer payload.
    expect(unionDeserialize(superjson.serialize(undefined))).toBeUndefined();
    expect(unionDeserialize(superjson.serialize(null))).toBeNull();
  });

  it('exposes a complete CombinedDataTransformer whose serialize slots stay superjson', () => {
    // Phase 1 invariant: every WRITE slot is superjson (wire unchanged). Assert by
    // shape-equality against superjson's own output.
    const x = { when: new Date('2024-01-01T00:00:00.000Z'), cursor: 42n };
    expect(unionTransformer.input.serialize(x)).toEqual(superjson.serialize(x));
    expect(unionTransformer.output.serialize(x)).toEqual(superjson.serialize(x));
    // READ slots are the union sniffer.
    expect(unionTransformer.input.deserialize(superjson.serialize(x))).toEqual(x);
    expect(unionTransformer.output.deserialize(devalueStringify(x))).toEqual(x);
  });
});

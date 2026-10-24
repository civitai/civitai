import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fastSuperjsonSerialize } from '~/server/trpc/superjson-fast-serialize';

/**
 * `fastSuperjsonSerialize` must produce exactly what `superjson.serialize` produces — the same
 * `json`, the same `meta`, in the same key order (the response body is `JSON.stringify` of it) —
 * and must do so WITHOUT running superjson on the shapes it handles itself.
 *
 * `superjson.serialize` is the oracle: every expectation below is computed from it (or pinned as
 * a literal), never from the function under test.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function expectIdentical(value: unknown) {
  const expected = superjson.serialize(value);
  const actual = fastSuperjsonSerialize(value);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual).toStrictEqual(expected);
  // And it decodes back to what superjson's own output decodes to.
  expect(superjson.deserialize(JSON.parse(JSON.stringify(actual)))).toStrictEqual(
    superjson.deserialize(JSON.parse(JSON.stringify(expected)))
  );
}

/** Runs `fastSuperjsonSerialize` and reports whether it fell back to `superjson.serialize`. */
function usedSuperjson(value: unknown): boolean {
  const spy = vi.spyOn(superjson, 'serialize');
  try {
    fastSuperjsonSerialize(value);
    return spy.mock.calls.length > 0;
  } finally {
    spy.mockRestore();
  }
}

/** A response-shaped payload: plain objects and arrays, Dates, nulls and undefined, nested. */
function feedLikePayload() {
  return {
    id: 7,
    metadata: { title: 'Featured', description: null },
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    items: [0, 1, 2].map((i) => ({
      id: 100 + i,
      name: `item ${i}`,
      nsfw: i % 2 === 0,
      score: i * 1.5,
      publishedAt: i === 1 ? null : new Date(Date.UTC(2026, 0, i + 1)),
      earlyAccessDeadline: i === 2 ? new Date(Date.UTC(2027, 5, 1)) : undefined,
      user: { id: 50 + i, username: `u${i}`, deletedAt: null, image: undefined },
      tags: [i, i + 1],
      images: [{ id: i, createdAt: new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999)), meta: {} }],
    })),
    empty: [],
    nothing: {},
  };
}

describe('fastSuperjsonSerialize — identical to superjson.serialize', () => {
  it.each([
    ['a response-shaped payload', feedLikePayload()],
    ['undefined at the root', undefined],
    ['null at the root', null],
    ['a string at the root', 'x'],
    ['a number at the root', 3],
    ['a Date at the root', new Date('2026-05-06T07:08:09.010Z')],
    ['an empty object', {}],
    ['an empty array', []],
    ['undefined inside arrays', [undefined, 1, undefined]],
    [
      'keys that need escaping',
      { 'a.b': undefined, 'c\\d': new Date(1), 'e\\.f': { 'g.h': undefined } },
    ],
    [
      // superjson builds annotations level by level, and an object enumerates integer-like keys
      // first: the array's `{ '1': …, '0.a': … }` is re-keyed under `k.` in THAT order.
      'integer-like annotation keys under a prefix',
      {
        k: [{ a: undefined }, undefined],
        2: [undefined],
        0: { 10: undefined, x: undefined, 1: undefined },
      },
    ],
    ['a deep nest', { a: { b: { c: { d: [{ e: [new Date(5), { f: undefined }] }] } } } }],
    [
      'a null-prototype object',
      Object.assign(Object.create(null), { a: undefined, b: new Date(2) }),
    ],
    // Shapes the fast walk hands to superjson — still identical, by construction.
    ['a BigInt', { n: 10n, nested: [1n] }],
    [
      'a Map',
      {
        m: new Map<unknown, unknown>([
          ['a', new Date(1)],
          [2, undefined],
        ]),
      },
    ],
    ['a Set', { s: new Set([1, 'two', undefined]) }],
    ['NaN, Infinity, -Infinity and -0', { a: NaN, b: Infinity, c: -Infinity, d: -0 }],
    ['an invalid Date', { d: new Date(NaN) }],
    ['a RegExp', { r: /x+/gi }],
    ['an Error', { e: new Error('boom') }],
    ['a URL', { u: new URL('https://example.com/a?b=c') }],
    [
      'a class instance',
      {
        c: new (class Money {
          amount = 3;
        })(),
      },
    ],
    ['a function', { f: () => 1 }],
    [
      'an object referenced twice',
      (() => {
        const o = { a: 1 };
        return { x: o, y: [o] };
      })(),
    ],
    [
      'a Date referenced twice',
      (() => {
        const d = new Date(3);
        return [d, { d }];
      })(),
    ],
    [
      'a circular reference',
      (() => {
        const o: Record<string, unknown> = { a: 1 };
        o.self = o;
        return o;
      })(),
    ],
    // eslint-disable-next-line no-sparse-arrays
    ['a sparse array', [1, , 3]],
    ['an array with an extra property', Object.assign([1, 2], { extra: undefined })],
    [
      'a sparse array with an extra property',
      (() => {
        const a: unknown[] & { foo?: number } = [];
        a[1] = 1;
        a.foo = 2;
        return a;
      })(),
    ],
  ])('%s', (_label, value) => {
    expectIdentical(value);
  });

  it('pins the wire for a Date and an undefined (a literal, not derived)', () => {
    expect(
      JSON.stringify(
        fastSuperjsonSerialize({ at: new Date('2026-01-02T03:04:05.000Z'), gone: undefined, n: 1 })
      )
    ).toBe(
      '{"json":{"at":"2026-01-02T03:04:05.000Z","gone":null,"n":1},"meta":{"values":{"at":["Date"],"gone":["undefined"]},"v":1}}'
    );
    expect(fastSuperjsonSerialize({ a: [1, 'x', null, true] })).toStrictEqual({
      json: { a: [1, 'x', null, true] },
    });
  });

  it('throws the same error as superjson on a prototype-pollution key', () => {
    const value = JSON.parse('{"ok":1,"inner":{"__proto__":{"x":1}}}');
    expect(() => superjson.serialize(value)).toThrow(/__proto__/);
    expect(() => fastSuperjsonSerialize(value)).toThrow(/__proto__/);
    expect(() => fastSuperjsonSerialize({ constructor: 1 })).toThrow(/constructor/);
  });

  it('matches superjson on randomly generated trees', () => {
    let seed = 0x5eed;
    const rand = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const keys = ['a', 'b', 'id', '0', '1', '10', '2', 'x.y', 'p\\q', 'createdAt', 'nested'];
    const shared = { s: 1 };
    let exotic = 0;
    const gen = (depth: number): unknown => {
      const r = rand();
      if (depth <= 0 || r < 0.35) {
        const leaf = pick<() => unknown>([
          () => 'str',
          () => '',
          () => Math.floor(rand() * 1000) - 500,
          () => rand(),
          () => true,
          () => false,
          () => null,
          () => undefined,
          () => new Date(Math.floor(rand() * 4e12)),
        ])();
        // Occasionally an exotic leaf, so the fallback path is exercised in mixed trees too.
        if (rand() < 0.03) {
          exotic++;
          return pick<() => unknown>([
            () => 5n,
            () => NaN,
            () => -0,
            () => new Map([[1, 2]]),
            () => new Set([1]),
            () => shared,
          ])();
        }
        return leaf;
      }
      if (r < 0.65) return Array.from({ length: Math.floor(rand() * 5) }, () => gen(depth - 1));
      const o: Record<string, unknown> = {};
      const n = Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) o[pick(keys)] = gen(depth - 1);
      return o;
    };
    let fastCount = 0;
    for (let i = 0; i < 400; i++) {
      const value = gen(5);
      expectIdentical(value);
      if (!usedSuperjson(value)) fastCount++;
    }
    // Both paths were exercised (positive controls for the loop above).
    expect(fastCount).toBeGreaterThan(200);
    expect(exotic).toBeGreaterThan(10);
  });
});

describe('fastSuperjsonSerialize — the fast path is actually taken', () => {
  it('does not run superjson.serialize on a plain payload', () => {
    expect(usedSuperjson(feedLikePayload())).toBe(false);
    expect(usedSuperjson([undefined, { a: new Date(1) }])).toBe(false);
  });

  it.each([
    ['a BigInt', { n: 1n }],
    ['a Map', { m: new Map() }],
    ['a Set', { s: new Set() }],
    ['NaN', [NaN]],
    ['-0', [-0]],
    [
      'a class instance',
      {
        c: new (class Decimalish {
          v = 1;
        })(),
      },
    ],
    [
      'a shared reference',
      (() => {
        const o = {};
        return [o, o];
      })(),
    ],
  ])('hands a payload with %s to superjson.serialize', (_label, value) => {
    expect(usedSuperjson(value)).toBe(true);
  });

  it('hands everything to superjson while a custom transformer is registered', () => {
    // A transformer that claims a plain string: without the registry check the fast walk would
    // write the string as-is, while superjson writes it through the transformer.
    superjson.registerCustom<string, string>(
      {
        isApplicable: (v): v is string => typeof v === 'string' && v.startsWith('money:'),
        serialize: (v) => v.slice('money:'.length),
        deserialize: (v) => `money:${v}`,
      },
      'test-money'
    );
    try {
      const value = { price: 'money:3', plain: 'x' };
      expect(usedSuperjson(value)).toBe(true);
      expectIdentical(value);
      expect(superjson.serialize(value).meta?.values).toStrictEqual({
        price: [['custom', 'test-money']],
      });
    } finally {
      const registry = (
        superjson as unknown as {
          defaultInstance: { customTransformerRegistry: { transfomers: Record<string, unknown> } };
        }
      ).defaultInstance.customTransformerRegistry.transfomers;
      delete registry['test-money'];
    }
    expect(usedSuperjson({ price: 'money:3' })).toBe(false);
  });
});

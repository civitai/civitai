import { beforeEach, describe, expect, it } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { blockPassThroughStepBodySchema } from '~/server/schema/blocks/workflow.schema';
import {
  BLOCK_QUOTE_GRANT_TTL_SECONDS,
  claimStepQuote,
  canonicalJson,
  claimQuoteGrant,
  hashPassThroughStepBody,
  isNonJsonQuotedBodyError,
  readQuoteGrant,
  readStepQuote,
  recordStepQuoteConsent,
  storeStepQuote,
} from '../block-quote-grant.service';

/**
 * The shared quote-grant store, exercised through its confirmed-STEP kind (`sq_…`).
 * The training kind keeps its own suite (`block-training-quote.service.test.ts`),
 * which runs over the same store; this file pins what is new — the step kind's id
 * shape and namespace, and that neither kind's id can address the other's record.
 */

function body(over: Record<string, unknown> = {}) {
  return blockPassThroughStepBodySchema.parse({
    kind: 'step',
    $type: 'polyGen',
    input: { engine: 'meshy', prompt: 'a teapot' },
    maxBuzz: 200,
    ...over,
  });
}

const binding = { userId: 42, appBlockId: 'apb_1', blockInstanceId: 'page_apb_1' };
const fields = { ...binding, total: 1040, bodyHash: 'h', stepType: 'polyGen' };

beforeEach(() => {
  redisMock.sysRedis.set.mockReset();
  redisMock.sysRedis.get.mockReset();
  redisMock.sysRedis.getDel.mockReset();
  redisMock.sysRedis.set.mockResolvedValue('OK');
});

describe('the step quote record', () => {
  it('is stored UNCONSENTED with a server-minted sq_ id, its own namespace and the TTL', async () => {
    const q = await storeStepQuote(fields);
    expect(q.quoteId).toMatch(/^sq_[a-f0-9]{32}$/);
    expect(q.consentedBy).toBeNull();
    expect(q.total).toBe(1040);
    expect(q.stepType).toBe('polyGen');
    const [key, , opts] = redisMock.sysRedis.set.mock.calls[0];
    expect(key).toBe(`system:blocks:step-quote:${q.quoteId}`);
    expect(opts).toEqual({ EX: BLOCK_QUOTE_GRANT_TTL_SECONDS });
    expect(BLOCK_QUOTE_GRANT_TTL_SECONDS).toBe(900);
  });

  it('consent records the session user, keeps the TTL, and never resurrects a claimed quote', async () => {
    const q = await storeStepQuote(fields);
    redisMock.sysRedis.get.mockResolvedValue(redisMock.sysRedis.set.mock.calls[0][1]);
    const updated = await recordStepQuoteConsent(q.quoteId, binding, 42);
    expect(updated?.consentedBy).toBe(42);
    const [key, value, opts] = redisMock.sysRedis.set.mock.calls[1];
    expect(key).toBe(`system:blocks:step-quote:${q.quoteId}`);
    expect(JSON.parse(value as string).consentedBy).toBe(42);
    expect(opts).toEqual({ XX: true, KEEPTTL: true });
  });

  it('🔴 consent after the submit CLAIMED the quote does not resurrect it', async () => {
    // A store that honours `XX` (and `GETDEL`), so this is the behaviour, not the
    // shape of the mock's arguments.
    const kv = new Map<string, string>();
    redisMock.sysRedis.set.mockImplementation((async (
      k: string,
      v: string,
      o?: { XX?: boolean }
    ) => {
      if (o?.XX && !kv.has(k)) return null;
      kv.set(k, v);
      return 'OK';
    }) as never);
    redisMock.sysRedis.get.mockImplementation((async (k: string) => kv.get(k) ?? null) as never);
    redisMock.sysRedis.getDel.mockImplementation((async (k: string) => {
      const v = kv.get(k) ?? null;
      kv.delete(k);
      return v;
    }) as never);
    const q = await storeStepQuote(fields);
    // Read between the claim and the consent write: the read still sees it…
    let claimed: unknown = null;
    redisMock.sysRedis.get.mockImplementationOnce((async (k: string) => {
      const v = kv.get(k) ?? null;
      claimed = await claimStepQuote(q.quoteId);
      return v;
    }) as never);
    // …but the claim landed first, so the XX write must not recreate the key.
    expect(await recordStepQuoteConsent(q.quoteId, binding, 42)).toBeNull();
    // Positive controls: the interleaving really happened (one read, a real claim).
    expect(redisMock.sysRedis.get).toHaveBeenCalledTimes(1);
    expect(claimed).toMatchObject({ quoteId: q.quoteId, total: 1040 });
    expect(kv.has(`system:blocks:step-quote:${q.quoteId}`)).toBe(false);
  });

  it('consent is refused for a session user who is not the quote’s subject', async () => {
    const q = await storeStepQuote(fields);
    redisMock.sysRedis.get.mockResolvedValue(redisMock.sysRedis.set.mock.calls[0][1]);
    expect(await recordStepQuoteConsent(q.quoteId, binding, 7)).toBeNull();
    expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another viewer', { ...binding, userId: 7 }],
    ['another app', { ...binding, appBlockId: 'apb_2' }],
    ['another install', { ...binding, blockInstanceId: 'page_x' }],
  ])('is unreadable and unconfirmable for %s', async (_l, other) => {
    const q = await storeStepQuote(fields);
    redisMock.sysRedis.get.mockResolvedValue(redisMock.sysRedis.set.mock.calls[0][1]);
    // Positive control: the binding it was stored for reads it.
    expect((await readStepQuote(q.quoteId, binding))?.total).toBe(1040);
    expect(await readStepQuote(q.quoteId, other)).toBeNull();
    expect(await recordStepQuoteConsent(q.quoteId, other, other.userId)).toBeNull();
  });

  it('a claim is GETDEL — single use — and a malformed id never reaches Redis', async () => {
    const q = await storeStepQuote(fields);
    redisMock.sysRedis.getDel.mockResolvedValueOnce(redisMock.sysRedis.set.mock.calls[0][1]);
    expect((await claimStepQuote(q.quoteId))?.total).toBe(1040);
    expect(redisMock.sysRedis.getDel).toHaveBeenCalledWith(`system:blocks:step-quote:${q.quoteId}`);
    redisMock.sysRedis.getDel.mockResolvedValueOnce(null);
    expect(await claimStepQuote(q.quoteId)).toBeNull();
    redisMock.sysRedis.getDel.mockClear();
    expect(await claimStepQuote('sq_nope')).toBeNull();
    expect(redisMock.sysRedis.getDel).not.toHaveBeenCalled();
  });

  it('neither kind’s id can address the other kind’s record', async () => {
    const tq = `tq_${'a'.repeat(32)}`;
    const sq = `sq_${'a'.repeat(32)}`;
    // A training id named as a step quote (and vice versa) is refused by shape,
    // before any key is built.
    expect(await claimStepQuote(tq)).toBeNull();
    expect(await claimQuoteGrant('training', sq)).toBeNull();
    expect(await readStepQuote(tq, binding)).toBeNull();
    expect(await readQuoteGrant('training', sq, binding)).toBeNull();
    expect(redisMock.sysRedis.getDel).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });
});

describe('hashPassThroughStepBody', () => {
  it('ignores quoteId and key order; changes with any other field', () => {
    const base = hashPassThroughStepBody(body());
    expect(hashPassThroughStepBody(body({ quoteId: `sq_${'b'.repeat(32)}` }))).toBe(base);
    expect(hashPassThroughStepBody(body({ input: { prompt: 'a teapot', engine: 'meshy' } }))).toBe(
      base
    );
    expect(hashPassThroughStepBody(body({ input: { engine: 'meshy', prompt: 'a cup' } }))).not.toBe(
      base
    );
    expect(hashPassThroughStepBody(body({ $type: 'otherGen' }))).not.toBe(base);
    expect(hashPassThroughStepBody(body({ maxBuzz: 201 }))).not.toBe(base);
  });
});

describe('canonicalJson — exact, or it throws', () => {
  it('plain JSON is canonical: keys sorted at every depth, undefined keys skipped', () => {
    expect(canonicalJson({ b: [1, 'x', true, null], a: { d: 2, c: undefined } })).toBe(
      '{"a":{"d":2},"b":[1,"x",true,null]}'
    );
    expect(canonicalJson(Object.assign(Object.create(null), { z: 1 }))).toBe('{"z":1}');
  });

  // Pairwise-distinct fixtures: each would previously have hashed like some other value.
  it.each([
    ['a Date', { v: new Date(7) }, 'body.v is a Date'],
    ['a Map', { v: new Map([[1, 2]]) }, 'body.v is a Map'],
    ['a Set', { v: new Set([3]) }, 'body.v is a Set'],
    ['a RegExp', { v: /4/ }, 'body.v is a RegExp'],
    ['a BigInt', { v: BigInt(5) }, 'body.v is a bigint'],
    ['a symbol', { v: Symbol('6') }, 'body.v is a symbol'],
    ['a function', { v: () => 8 }, 'body.v is a function'],
    ['Infinity', { v: Number.POSITIVE_INFINITY }, 'body.v is the non-finite number Infinity'],
    ['NaN', { v: Number.NaN }, 'body.v is the non-finite number NaN'],
    ['an undefined array element', { v: [9, undefined] }, 'body.v[1] is undefined'],
    [
      'a nested class instance',
      { a: [{ b: new URL('https://example.com/10') }] },
      'body.a[0].b is a URL',
    ],
  ])('refuses %s, naming the path', (_l, value, message) => {
    let thrown: unknown;
    try {
      canonicalJson(value);
    } catch (e) {
      thrown = e;
    }
    expect(isNonJsonQuotedBodyError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe(message);
  });

  // A sparse array's empty slots are skipped by `map`/`join`, so each of these used to
  // hash like a shorter array. Holes at the start, middle and end; none equals `[]` or
  // `[null]`, and the plain neighbours they would have collided with still hash.
  it.each([
    // eslint-disable-next-line no-sparse-arrays
    ['a hole at the start', { v: [, 11, 12] }, 'body.v[0] is an empty array slot'],
    // eslint-disable-next-line no-sparse-arrays
    ['a hole in the middle', { v: [13, , 14] }, 'body.v[1] is an empty array slot'],
    [
      'a hole at the end',
      { v: Object.assign([15, 16], { length: 3 }) },
      'body.v[2] is an empty array slot',
    ],
    ['an array that is only a hole', { v: new Array(1) }, 'body.v[0] is an empty array slot'],
  ])('refuses %s, naming the slot', (_l, value, message) => {
    let thrown: unknown;
    try {
      canonicalJson(value);
    } catch (e) {
      thrown = e;
    }
    expect(isNonJsonQuotedBodyError(thrown)).toBe(true);
    expect((thrown as Error).message).toBe(message);
  });

  it('control: the dense arrays a sparse one could have been mistaken for all hash, and differ', () => {
    const forms = [[], [null], [11, 12], [13, 14], [15, 16]].map((v) => canonicalJson({ v }));
    expect(forms).toEqual([
      '{"v":[]}',
      '{"v":[null]}',
      '{"v":[11,12]}',
      '{"v":[13,14]}',
      '{"v":[15,16]}',
    ]);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it('the values that used to collide no longer produce a hash at all', () => {
    const hash = (input: Record<string, unknown>) =>
      hashPassThroughStepBody({ kind: 'step', $type: 'polyGen', input, maxBuzz: 1 } as never);
    expect(() => hash({ when: new Date(1) })).toThrow('body.input.when is a Date');
    expect(() => hash({ when: new Date(2) })).toThrow('body.input.when is a Date');
    expect(() => hash({ when: new Map() })).toThrow('body.input.when is a Map');
    // Positive control: the plain forms hash, and differ.
    expect(hash({ when: 1 })).not.toBe(hash({ when: 2 }));
    expect(hash({ when: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

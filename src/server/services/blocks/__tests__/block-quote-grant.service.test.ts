import { beforeEach, describe, expect, it } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { blockPassThroughStepBodySchema } from '~/server/schema/blocks/workflow.schema';
import {
  BLOCK_QUOTE_GRANT_TTL_SECONDS,
  claimStepQuote,
  claimQuoteGrant,
  confirmedStepRunGenerationKey,
  hashPassThroughStepBody,
  quotedRunKey,
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
    redisMock.sysRedis.get.mockImplementationOnce((async (k: string) => {
      const v = kv.get(k) ?? null;
      expect(await claimStepQuote(q.quoteId)).not.toBeNull();
      return v;
    }) as never);
    // …but the claim landed first, so the XX write must not recreate the key.
    expect(await recordStepQuoteConsent(q.quoteId, binding, 42)).toBeNull();
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

describe('the confirmed-step run identity', () => {
  it('the generation counter is per viewer, app and body', () => {
    const k = confirmedStepRunGenerationKey(42, 'apb_1', 'h1');
    expect(k).toBe('system:blocks:step-quote:runs:42:apb_1:h1');
    expect(confirmedStepRunGenerationKey(7, 'apb_1', 'h1')).not.toBe(k);
    expect(confirmedStepRunGenerationKey(42, 'apb_2', 'h1')).not.toBe(k);
    expect(confirmedStepRunGenerationKey(42, 'apb_1', 'h2')).not.toBe(k);
  });

  it('the run key is the sha256 of app, body hash and generation — each one moves it', () => {
    const k0 = quotedRunKey('apb_1', 'h1', 0);
    // A LITERAL, not a re-derivation: sha256("apb_1\nh1\n0").
    expect(k0).toBe('7a2d26ab15b538fd72a15c0e476c2ddc47e3f1160eee7fdd691d9e86c8d192be');
    expect(quotedRunKey('apb_1', 'h1', 1)).not.toBe(k0);
    expect(quotedRunKey('apb_2', 'h1', 0)).not.toBe(k0);
    expect(quotedRunKey('apb_1', 'h2', 0)).not.toBe(k0);
    expect(quotedRunKey('apb_1', 'h1', 0)).toBe(k0);
  });
});

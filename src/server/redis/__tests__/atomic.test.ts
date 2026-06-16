import { describe, it, expect, vi } from 'vitest';
import { hSetWithTTL, hSetMultiWithTTL, zAddWithTTL } from '../atomic';

/**
 * Unit tests for the EVAL-based atomic hash-field+TTL helpers.
 *
 * These tests exercise the Lua-script wiring at the JS boundary only —
 * they assert that the helper passes the correct script + KEYS + ARGV
 * shape to `client.eval`. We don't reach a real Redis here. End-to-end
 * verification (HSET landed + HPTTL > 0) is documented as a manual step
 * in the PR description.
 */

function mockClient() {
  return {
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe('hSetWithTTL', () => {
  it('passes key as KEYS[1] and field/value/ttl as ARGV', async () => {
    const client = mockClient();
    await hSetWithTTL(client, 'my:hash', 'field-1', 'value-1', 5000);

    expect(client.eval).toHaveBeenCalledTimes(1);
    const [script, options] = client.eval.mock.calls[0];

    // Script does HSET + HPEXPIRE on the same key in a single EVAL.
    expect(script).toContain("redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])");
    expect(script).toContain(
      "redis.call('HPEXPIRE', KEYS[1], ARGV[3], 'FIELDS', 1, ARGV[1])"
    );

    expect(options.keys).toEqual(['my:hash']);
    expect(options.arguments).toEqual(['field-1', 'value-1', '5000']);
  });

  // REGRESSION GUARD (#2332-hotfix): the original cut shipped with
  // `value as unknown as string`, leaving numeric values as runtime numbers
  // when they reached node-redis's encodeCommand — which then crashed on
  // every `setToken(userId, Date.now(), ...)` call in prod. The fail-open
  // wrappers absorbed the throws (no user-visible 500s) but every
  // session/token write SILENTLY DROPPED, leaving sysRedis out-of-sync
  // until rollback. This test must keep the asserted `'42'` (string) shape;
  // if it ever flips back to `42` (number), the regression is back.
  it('stringifies numeric values before reaching node-redis encodeCommand', async () => {
    const client = mockClient();
    await hSetWithTTL(client, 'k', 'f', 42, 1000);
    expect(client.eval.mock.calls[0][1].arguments).toEqual(['f', '42', '1000']);
  });

  it('forwards Buffer values without coercion (msgpack-packed write path)', async () => {
    const client = mockClient();
    const packed = Buffer.from([0x81, 0xa1, 0x61, 0x01]); // {a: 1} packed
    await hSetWithTTL(client, 'k', 'f', packed, 1000);
    expect(client.eval.mock.calls[0][1].arguments[1]).toBe(packed);
  });

  // PR #2332 round-3 guard: HPEXPIRE with 0/negative ms REMOVES the field —
  // an accidental config bug (e.g. `someConfig.ttlSeconds * 1000` evaluating
  // to 0 or NaN) would silently destroy the very write this helper just
  // performed. The guard MUST fire before the EVAL is dispatched so a
  // missing TTL never reaches the server.
  it('throws on non-positive ttlMs and never calls EVAL', async () => {
    const client = mockClient();
    await expect(hSetWithTTL(client, 'k', 'f', 'v', 0)).rejects.toThrow(/positive finite number/);
    await expect(hSetWithTTL(client, 'k', 'f', 'v', -1)).rejects.toThrow(/positive finite number/);
    await expect(hSetWithTTL(client, 'k', 'f', 'v', NaN)).rejects.toThrow(/positive finite number/);
    await expect(hSetWithTTL(client, 'k', 'f', 'v', Infinity)).rejects.toThrow(
      /positive finite number/
    );
    expect(client.eval).not.toHaveBeenCalled();
  });
});

describe('hSetMultiWithTTL', () => {
  it('passes ttl, count, then field-names followed by values in ARGV', async () => {
    const client = mockClient();
    await hSetMultiWithTTL(
      client,
      'tokens:user-1',
      { 'token-a': 'invalid', 'token-b': 'refresh' },
      30_000
    );

    expect(client.eval).toHaveBeenCalledTimes(1);
    const [script, options] = client.eval.mock.calls[0];

    expect(script).toContain("redis.call('HSET'");
    expect(script).toContain("redis.call('HPEXPIRE'");
    expect(options.keys).toEqual(['tokens:user-1']);
    // ARGV layout: [ttlMs, count, ...fieldNames, ...values]
    expect(options.arguments).toEqual([
      '30000',
      '2',
      'token-a',
      'token-b',
      'invalid',
      'refresh',
    ]);
  });

  it('no-ops on empty input (avoids EVAL with zero fields)', async () => {
    const client = mockClient();
    await hSetMultiWithTTL(client, 'k', {}, 1000);
    expect(client.eval).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD (#2332-hotfix): same numeric-value bug as the
  // single-field hSetWithTTL had. Each value in the entries map was cast
  // `as unknown as string` without runtime coercion, crashing on any
  // numeric value (e.g. token timestamps in session-invalidation).
  it('stringifies numeric values + forwards Buffer values unchanged', async () => {
    const client = mockClient();
    const packed = Buffer.from([0x80]);
    await hSetMultiWithTTL(
      client,
      'k',
      { 'token-num': 123, 'token-str': 'str', 'token-buf': packed },
      10_000
    );
    const args = client.eval.mock.calls[0][1].arguments;
    // ARGV: [ttl, count, ...fieldNames, ...values]
    expect(args.slice(0, 5)).toEqual(['10000', '3', 'token-num', 'token-str', 'token-buf']);
    expect(args[5]).toEqual('123'); // number → string
    expect(args[6]).toEqual('str'); // string → string
    expect(args[7]).toBe(packed); // Buffer → Buffer (reference identity)
  });

  // PR #2332 round-3 guard — see hSetWithTTL twin test above.
  it('throws on non-positive ttlMs and never calls EVAL', async () => {
    const client = mockClient();
    const fields = { f: 'v' };
    await expect(hSetMultiWithTTL(client, 'k', fields, 0)).rejects.toThrow(
      /positive finite number/
    );
    await expect(hSetMultiWithTTL(client, 'k', fields, -1)).rejects.toThrow(
      /positive finite number/
    );
    await expect(hSetMultiWithTTL(client, 'k', fields, NaN)).rejects.toThrow(
      /positive finite number/
    );
    await expect(hSetMultiWithTTL(client, 'k', fields, Infinity)).rejects.toThrow(
      /positive finite number/
    );
    expect(client.eval).not.toHaveBeenCalled();
  });
});

describe('zAddWithTTL', () => {
  it('passes key as KEYS[1] and score/member/ttl as ARGV', async () => {
    const client = mockClient();
    await zAddWithTTL(client, 'my:zset', 42, 'member-1', 5000);

    expect(client.eval).toHaveBeenCalledTimes(1);
    const [script, options] = client.eval.mock.calls[0];

    // Script does ZADD + PEXPIRE on the same key in a single EVAL.
    expect(script).toContain("redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[3])");

    expect(options.keys).toEqual(['my:zset']);
    expect(options.arguments).toEqual(['42', 'member-1', '5000']);
  });

  it('stringifies numeric score', async () => {
    const client = mockClient();
    await zAddWithTTL(client, 'k', 0, 'm', 1000);
    expect(client.eval.mock.calls[0][1].arguments).toEqual(['0', 'm', '1000']);
  });

  // PR #2332 round-3 guard: PEXPIRE with 0/negative ms DELETES the key —
  // would destroy the sorted set ZADD just wrote into. See atomic.ts
  // header for the full failure-mode rationale.
  it('throws on non-positive ttlMs and never calls EVAL', async () => {
    const client = mockClient();
    await expect(zAddWithTTL(client, 'k', 1, 'm', 0)).rejects.toThrow(/positive finite number/);
    await expect(zAddWithTTL(client, 'k', 1, 'm', -1)).rejects.toThrow(/positive finite number/);
    await expect(zAddWithTTL(client, 'k', 1, 'm', NaN)).rejects.toThrow(/positive finite number/);
    await expect(zAddWithTTL(client, 'k', 1, 'm', Infinity)).rejects.toThrow(
      /positive finite number/
    );
    expect(client.eval).not.toHaveBeenCalled();
  });
});

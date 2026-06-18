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

  it('stringifies numeric values', async () => {
    const client = mockClient();
    await hSetWithTTL(client, 'k', 'f', 42, 1000);
    // node-redis v5 EVAL rejects raw numbers ("arguments[N] must be of type
    // string | Buffer, got number") — numeric values MUST be stringified.
    expect(client.eval.mock.calls[0][1].arguments).toEqual(['f', '42', '1000']);
    for (const arg of client.eval.mock.calls[0][1].arguments) {
      expect(typeof arg === 'string' || Buffer.isBuffer(arg)).toBe(true);
    }
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

  it('stringifies numeric values (node-redis v5 EVAL rejects raw numbers)', async () => {
    const client = mockClient();
    await hSetMultiWithTTL(client, 'k', { 'f-1': 42, 'f-2': 'v' }, 1000);
    // ARGV: [ttl, count, ...fields, ...values] — numeric value must be '42'
    expect(client.eval.mock.calls[0][1].arguments).toEqual(['1000', '2', 'f-1', 'f-2', '42', 'v']);
    for (const arg of client.eval.mock.calls[0][1].arguments) {
      expect(typeof arg === 'string' || Buffer.isBuffer(arg)).toBe(true);
    }
  });

  it('no-ops on empty input (avoids EVAL with zero fields)', async () => {
    const client = mockClient();
    await hSetMultiWithTTL(client, 'k', {}, 1000);
    expect(client.eval).not.toHaveBeenCalled();
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

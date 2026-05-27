import { describe, it, expect, vi } from 'vitest';
import { hSetWithTTL, hSetMultiWithTTL } from '../atomic';

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
    expect(client.eval.mock.calls[0][1].arguments).toEqual(['f', 42, '1000']);
  });

  it('forwards Buffer values without coercion (msgpack-packed write path)', async () => {
    const client = mockClient();
    const packed = Buffer.from([0x81, 0xa1, 0x61, 0x01]); // {a: 1} packed
    await hSetWithTTL(client, 'k', 'f', packed, 1000);
    expect(client.eval.mock.calls[0][1].arguments[1]).toBe(packed);
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
});

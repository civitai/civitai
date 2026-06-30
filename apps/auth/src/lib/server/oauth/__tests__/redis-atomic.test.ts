import { describe, it, expect, vi } from 'vitest';
import { hSetWithTTL } from '../redis-atomic';

// The atomic auth-code write is security-relevant: a no-TTL OAuth code is a single-use credential that
// never expires. Pin (1) the positive-finite-ttl guard that prevents HPEXPIRE-as-delete, and (2) the
// EVAL arg layout [field, value, ttlMs] so a regression in either is caught.

describe('hSetWithTTL guard', () => {
  it('throws on non-positive ttl (HPEXPIRE with <=0 ms deletes the field)', async () => {
    const client = { eval: vi.fn() };
    await expect(hSetWithTTL(client, 'k', 'f', 'v', 0)).rejects.toThrow(/positive finite/);
    await expect(hSetWithTTL(client, 'k', 'f', 'v', -1)).rejects.toThrow(/positive finite/);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('throws on non-finite ttl', async () => {
    const client = { eval: vi.fn() };
    await expect(hSetWithTTL(client, 'k', 'f', 'v', Infinity)).rejects.toThrow(/positive finite/);
    await expect(hSetWithTTL(client, 'k', 'f', 'v', NaN)).rejects.toThrow(/positive finite/);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('issues a single EVAL with keys=[key] and arguments=[field, value, ttlMs]', async () => {
    const client = { eval: vi.fn().mockResolvedValue(1) };
    const buf = Buffer.from([1, 2, 3]);
    await hSetWithTTL(client, 'hashkey', 'field1', buf, 600_000);
    expect(client.eval).toHaveBeenCalledTimes(1);
    const [script, opts] = client.eval.mock.calls[0];
    expect(script).toMatch(/HSET/);
    expect(script).toMatch(/HPEXPIRE/);
    expect(opts.keys).toEqual(['hashkey']);
    expect(opts.arguments[0]).toBe('field1');
    expect(opts.arguments[1]).toBe(buf); // Buffer passed through unchanged (packed bytes preserved)
    expect(opts.arguments[2]).toBe('600000'); // ttlMs stringified
  });

  it('stringifies a numeric value', async () => {
    const client = { eval: vi.fn().mockResolvedValue(1) };
    await hSetWithTTL(client, 'k', 'f', 42, 1000);
    expect(client.eval.mock.calls[0][1].arguments[1]).toBe('42');
  });
});

import { describe, expect, it } from 'vitest';
import { replicaFallbackFor } from '~/server/db/replica-fallback';

// The fallback is dark: with DATABASE_REPLICA_FALLBACK off nothing is wired, so the read clients
// behave exactly as before. On, each read client gets a fallback capped at the configured size.
describe('replicaFallbackFor', () => {
  it('wires nothing while the flag is off', () => {
    expect(
      replicaFallbackFor('primaryRead', { replicaFallback: false, replicaFallbackMax: 4 })
    ).toBeUndefined();
  });

  it('wires a fallback when the flag is on', () => {
    const fallback = replicaFallbackFor('primaryRead', {
      replicaFallback: true,
      replicaFallbackMax: 3,
    });
    expect(fallback).toBeDefined();
    expect(fallback!.inFlight).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { WORKER_PROVIDERS } from '../../../../../apps/auth/src/lib/server/oauth/worker-admin';
import {
  generateProviderSecret,
  hashProviderSecret,
  isProviderToken,
  liveProviderTokens,
  matchProviderToken,
  parseProviderTokenRecords,
  type ProviderTokenRecord,
} from '~/server/services/provider-download/provider-token';

const record = (provider: string, secret: string, extra: Partial<ProviderTokenRecord> = {}) =>
  ({
    id: `id-${provider}`,
    provider,
    hash: hashProviderSecret(secret),
    mintedAt: '2026-11-09T00:00:00.000Z',
    retiredAt: null,
    retiredFor: null,
    hourlyCeiling: 1000,
    ...extra,
  } satisfies ProviderTokenRecord);

describe('per-provider download tokens resolve for every orchestrator provider name', () => {
  // The names a worker pool registers under, spelled as the orchestrator spells them (mixed case).
  it.each(WORKER_PROVIDERS.map((name) => [name]))('%s', (provider) => {
    const secret = generateProviderSecret();
    const other = generateProviderSecret();
    const live = liveProviderTokens(
      parseProviderTokenRecords([record(provider, secret)]),
      new Set(WORKER_PROVIDERS)
    );

    expect(matchProviderToken(`${provider}:${secret}`, live)?.provider).toBe(provider);
    expect(matchProviderToken(`${provider}:${other}`, live)).toBeNull();
  });
});

describe('matchProviderToken', () => {
  const secret = generateProviderSecret();
  const live = [record('RunPods', secret)];

  it("refuses another provider's name with the right secret", () => {
    expect(matchProviderToken(`FalAI:${secret}`, live)).toBeNull();
  });

  it('splits on the first colon only', () => {
    expect(matchProviderToken(`RunPods:${secret}:x`, live)).toBeNull();
    expect(matchProviderToken(`RunPods:${secret}`, live)).not.toBeNull();
  });

  it('refuses a malformed provider name', () => {
    expect(matchProviderToken(`Run Pods:${secret}`, live)).toBeNull();
    expect(matchProviderToken(`:${secret}`, live)).toBeNull();
  });

  it('finds the live one of two tokens for a provider, so a roll keeps both working', () => {
    const next = generateProviderSecret();
    const both = [...live, record('RunPods', next, { id: 'id-2' })];
    expect(matchProviderToken(`RunPods:${secret}`, both)).not.toBeNull();
    expect(matchProviderToken(`RunPods:${next}`, both)).not.toBeNull();
  });
});

describe('liveProviderTokens', () => {
  const secret = generateProviderSecret();

  it('drops a retired token', () => {
    const records = [
      record('RunPods', secret, { retiredAt: '2026-11-09T01:00:00.000Z', retiredFor: 'planned' }),
    ];
    const live = liveProviderTokens(records, new Set(['RunPods']));
    expect(matchProviderToken(`RunPods:${secret}`, live)).toBeNull();
  });

  it('drops a token whose provider no worker client uses', () => {
    const live = liveProviderTokens([record('RunPods', secret)], new Set(['FalAI']));
    expect(matchProviderToken(`RunPods:${secret}`, live)).toBeNull();
  });
});

describe('isProviderToken', () => {
  it('treats any colon as a provider token and a user API key as not one', () => {
    expect(isProviderToken('a:b')).toBe(true);
    expect(isProviderToken('0123456789abcdef0123456789abcdef')).toBe(false);
  });
});

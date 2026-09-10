import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { BlockRevocation } from '../block-revocation.service';
import { BLOCK_TOKEN_LIFETIMES_SECONDS } from '../block-token-lifetimes';
import { BlockTokenService } from '../block-token.service';

/**
 * A revocation marker that expires before the token it revokes stops the gate
 * refusing, and stops it SILENTLY — `isRevoked` reads an absent key as "not
 * revoked", so nothing errors and nothing is logged. That is what happened when
 * dev:live tokens went to 4h and this TTL stayed at 15min.
 *
 * The assertions below therefore compare the marker's TTL against lifetimes
 * OBSERVED from real signed tokens, never against a copied number: a literal
 * expectation drifts with whichever of the two constants is edited next, which
 * is the defect itself rather than a guard against it.
 */

type Kind = keyof typeof BLOCK_TOKEN_LIFETIMES_SECONDS;

const baseInput = {
  userId: 7,
  blockId: 'blk_ttl',
  appId: 'app_ttl',
  appBlockId: 'apb_ttl',
  blockInstanceId: 'bki_ttl',
  ctx: {},
};

const MINT_PER_KIND: Record<Kind, Parameters<typeof BlockTokenService.sign>[0]> = {
  default: { ...baseInput, scopes: ['models:read:self'] },
  settings: { ...baseInput, scopes: ['block:settings:read'] },
  dev: { ...baseInput, scopes: ['models:read:self'], dev: true },
};

/** `exp - iat` off the real signed JWT — what the token is actually worth. */
async function signedLifetimeSeconds(kind: Kind): Promise<number> {
  const input = MINT_PER_KIND[kind];
  expect(
    input,
    `no mint recipe for the "${kind}" lifetime — add one, or this kind is measured by nothing`
  ).toBeTruthy();
  const { token } = await BlockTokenService.sign(input);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  expect(typeof payload.exp, `${kind} token carries no exp`).toBe('number');
  expect(typeof payload.iat, `${kind} token carries no iat`).toBe('number');
  return payload.exp - payload.iat;
}

/** The EX the service actually hands Redis, not the constant behind it. */
async function markerTtlSeconds(): Promise<number> {
  redisMock.redis.set.mockClear();
  await BlockRevocation.revokeInstance('bki_ttl_probe');
  const call = redisMock.redis.set.mock.calls.at(-1);
  expect(call, 'revokeInstance wrote no Redis key — this probe is measuring nothing').toBeTruthy();
  const ex = (call![2] as { EX?: number } | undefined)?.EX;
  expect(typeof ex, 'revokeInstance set a key with no EX — the marker never expires').toBe(
    'number'
  );
  return ex as number;
}

describe('a revocation marker outlives every token it can revoke', () => {
  it('distinguishes the token kinds it is about to compare against', async () => {
    // Positive control. If the probe returned one constant regardless of input,
    // every assertion below would pass while measuring nothing.
    const [dev, def, settings] = await Promise.all([
      signedLifetimeSeconds('dev'),
      signedLifetimeSeconds('default'),
      signedLifetimeSeconds('settings'),
    ]);
    expect(dev).toBeGreaterThan(def);
    expect(def).toBeGreaterThan(settings);
  });

  it.each(Object.keys(BLOCK_TOKEN_LIFETIMES_SECONDS) as Kind[])(
    'covers a %s token for its whole life',
    async (kind) => {
      const lifetime = await signedLifetimeSeconds(kind);
      const ttl = await markerTtlSeconds();
      expect(
        ttl,
        `a ${kind} token is valid for ${lifetime}s but the revocation marker expires after ${ttl}s, ` +
          `leaving ${lifetime - ttl}s in which a revoked token is still accepted`
      ).toBeGreaterThanOrEqual(lifetime);
    }
  );
});

describe('the signer mints no lifetime the marker TTL is unaware of', () => {
  // The suite above can only compare against kinds it enumerates, so a new one
  // minted from a constant of its own would be covered by nothing. This reads
  // the signer's own selection instead: the ledger has to match in BOTH
  // directions, or `MAX_BLOCK_TOKEN_LIFETIME_SECONDS` is not the max.
  const source = readFileSync(path.join(__dirname, '../block-token.service.ts'), 'utf8');
  const expression = source.match(/const lifetime =([\s\S]*?);/)?.[1];

  it('selects its lifetime somewhere this test can read', () => {
    expect(
      expression,
      'no `const lifetime = …` in block-token.service.ts — if the selection moved, point this guard at it'
    ).toBeTruthy();
  });

  it('takes every branch from the shared lifetime record', () => {
    const residue = expression!.replace(/BLOCK_TOKEN_LIFETIMES_SECONDS\.\w+/g, '');
    expect(
      residue,
      'the lifetime selection has a hard-coded duration; move it into BLOCK_TOKEN_LIFETIMES_SECONDS ' +
        'so the revocation TTL rises with it'
    ).not.toMatch(/\d/);
    expect(
      residue,
      'the lifetime selection reads a duration constant outside BLOCK_TOKEN_LIFETIMES_SECONDS'
    ).not.toMatch(/[A-Z][A-Z0-9_]*_SECONDS/);
  });

  it('mints every kind the record declares, and no other', () => {
    const referenced = new Set(
      [...expression!.matchAll(/BLOCK_TOKEN_LIFETIMES_SECONDS\.(\w+)/g)].map((m) => m[1])
    );
    expect(
      [...referenced].sort(),
      'BLOCK_TOKEN_LIFETIMES_SECONDS and the signer disagree — an entry nothing mints still inflates ' +
        'the max, and a kind minted from elsewhere is not counted by it'
    ).toEqual(Object.keys(BLOCK_TOKEN_LIFETIMES_SECONDS).sort());
  });
});

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

/**
 * EVERY method that writes a revocation marker, and therefore every method whose `EX`
 * has to outlive the longest token.
 *
 * 🔴 THIS USED TO PROBE ONLY `revokeInstance`, AND THE GAP WAS A SURVIVING MUTANT.
 * Measured: `revokeInstanceForBan`'s `EX` → 900 kept 5 files / 116 tests GREEN. A ban
 * marker expiring at 900s while a banned publisher's `dev:true` token is valid to 14400s
 * means that from T+900s `isRevoked` reads an absent key as "not revoked" and serves the
 * token again — silently, which is verbatim the defect this file's header exists to
 * prevent, on the keyspace where it matters most.
 *
 * Keyed by KEYSPACE, and the ledger guard below fails if a writer appears that is not
 * here — a third keyspace must not be able to ship unprobed the way the second did.
 */
const MARKER_WRITERS = {
  install: (id: string) => BlockRevocation.revokeInstance(id),
  ban: (id: string) => BlockRevocation.revokeInstanceForBan(id),
} as const;
type MarkerWriter = keyof typeof MARKER_WRITERS;

/** The EX the service actually hands Redis, not the constant behind it. */
async function markerTtlSeconds(writer: MarkerWriter): Promise<number> {
  redisMock.redis.set.mockClear();
  await MARKER_WRITERS[writer](`bki_ttl_probe_${writer}`);
  const call = redisMock.redis.set.mock.calls.at(-1);
  expect(
    call,
    `the ${writer} writer wrote no Redis key — this probe is measuring nothing`
  ).toBeTruthy();
  const ex = (call![2] as { EX?: number } | undefined)?.EX;
  expect(typeof ex, `the ${writer} writer set a key with no EX — that marker never expires`).toBe(
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

  // The CROSS PRODUCT, not one writer × every kind. Each keyspace is written by its own
  // method with its own `EX` argument, so each has to be measured on its own.
  it.each(
    (Object.keys(MARKER_WRITERS) as MarkerWriter[]).flatMap((writer) =>
      (Object.keys(BLOCK_TOKEN_LIFETIMES_SECONDS) as Kind[]).map((kind) => [writer, kind] as const)
    )
  )('the %s marker covers a %s token for its whole life', async (writer, kind) => {
    const lifetime = await signedLifetimeSeconds(kind);
    const ttl = await markerTtlSeconds(writer);
    expect(
      ttl,
      `a ${kind} token is valid for ${lifetime}s but the ${writer} revocation marker expires ` +
        `after ${ttl}s, leaving ${lifetime - ttl}s in which a revoked token is still accepted`
    ).toBeGreaterThanOrEqual(lifetime);
  });

  /**
   * 🔴 THE LEDGER. The cross product above can only measure writers it knows about, so a
   * THIRD keyspace added later would ship with no TTL guard exactly as the ban keyspace
   * did. This reads the service's own surface instead: every `revoke*` static must be
   * probed here.
   */
  it('probes every marker-writing method the service exposes', () => {
    const source = readFileSync(path.join(__dirname, '../block-revocation.service.ts'), 'utf8');
    const writers = [...source.matchAll(/static async (revoke\w*)\s*\(/g)].map((m) => m[1]).sort();
    expect(
      writers.length,
      'no `static async revoke*` found — this ledger is reading nothing'
    ).toBeGreaterThan(0);
    const probed = ['revokeInstance', 'revokeInstanceForBan'].sort();
    expect(
      writers,
      'block-revocation.service.ts exposes a marker writer that MARKER_WRITERS does not ' +
        'probe. Its EX is then guarded by nothing, and a marker that expires before the ' +
        'token it revokes stops refusing SILENTLY — add it to MARKER_WRITERS.'
    ).toEqual(probed);
  });
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

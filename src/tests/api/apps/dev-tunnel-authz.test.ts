import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { fingerprintSshPublicKey, normalizeSshPublicKey } from '~/server/services/blocks/dev-tunnel-session';

/**
 * APP DEV TUNNEL — coverage for the sish authz callback
 * `POST /api/apps/dev-tunnel/authz/<secret>`. The shared secret is carried in the
 * URL PATH (F5: sish v2.23.0 cannot attach a custom header), not a header.
 * `user` / `remote_addr` are attacker-controlled → never authz'd on; the decision
 * is the presented `auth_key` matching a live userId-bound credential
 * (constant-time), gated by the path secret. Single-use → replay denied.
 */

const { mockLookup, mockConsume, mockEnv } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockConsume: vi.fn(async (..._a: unknown[]) => undefined),
  mockEnv: { APPS_DEV_TUNNEL_SISH_SECRET: 'sish-shared-secret' as string | undefined },
}));

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  lookupCredentialByFingerprint: (...a: unknown[]) => mockLookup(...a),
  consumeDevTunnelCredential: (...a: unknown[]) => mockConsume(...a),
}));

import handler from '~/pages/api/apps/dev-tunnel/authz/[secret]';

const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBytes0123456789abcdefg dev@laptop';
const NORMALIZED = normalizeSshPublicKey(PUBKEY);
const FP = fingerprintSshPublicKey(PUBKEY)!;
const NOW = Math.floor(Date.now() / 1000);

const validCred = {
  sessionId: 'bki_abc',
  userId: 555,
  blockId: 'my-app',
  host: 'dev-0123456789abcdef.civit.ai',
  sshPublicKey: NORMALIZED,
  hardExpiresAt: NOW + 3600,
};

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(p: unknown) {
      this.body = p;
      return this;
    },
    _headers: headers,
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

function makeReq(opts: {
  /** The trailing path segment (the shared secret). `undefined` ⇒ no path param
   *  at all (e.g. a request that somehow reached the handler with no [secret]). */
  secret?: string | string[];
  authKey?: string;
  user?: string;
  remoteAddr?: string;
  method?: string;
}): NextApiRequest {
  const query: Record<string, string | string[]> = {};
  if (opts.secret !== undefined) query.secret = opts.secret;
  return {
    method: opts.method ?? 'POST',
    headers: {},
    query,
    body: { auth_key: opts.authKey, user: opts.user, remote_addr: opts.remoteAddr },
  } as unknown as NextApiRequest;
}

describe('POST /api/apps/dev-tunnel/authz/<secret>', () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockConsume.mockClear();
    mockEnv.APPS_DEV_TUNNEL_SISH_SECRET = 'sish-shared-secret';
  });
  afterEach(() => vi.clearAllMocks());

  it('valid PATH secret + matching pubkey → 200 (and consumes the credential)', async () => {
    mockLookup.mockResolvedValue(validCred);
    const res = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', authKey: PUBKEY, user: 'anything' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.auth).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith(FP);
  });

  it('FORGED user field is IGNORED — authz rests on the pubkey only', async () => {
    // A malicious client claims to be another user; the pubkey still matches its
    // own credential → authorized as the credential's userId, not the claim.
    mockLookup.mockResolvedValue(validCred);
    const res = makeRes();
    await handler(
      makeReq({ secret: 'sish-shared-secret', authKey: PUBKEY, user: 'root; DROP TABLE' }),
      res
    );
    expect(res.statusCode).toBe(200);
  });

  it('REPLAYED key → deny (single-use consume: second lookup misses)', async () => {
    // First bind consumes; the replay's lookup returns null → 403.
    mockLookup.mockResolvedValueOnce(validCred).mockResolvedValueOnce(null);
    const res1 = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', authKey: PUBKEY }), res1);
    expect(res1.statusCode).toBe(200);
    const res2 = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', authKey: PUBKEY }), res2);
    expect(res2.statusCode).toBe(403);
  });

  it('EXPIRED credential (lookup returns null) → 403', async () => {
    mockLookup.mockResolvedValue(null); // lookup already filters expired
    const res = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', authKey: PUBKEY }), res);
    expect(res.statusCode).toBe(403);
  });

  it('WRONG pubkey (fingerprint hits a different credential) → 403 (constant-time compare fails)', async () => {
    mockLookup.mockResolvedValue({
      ...validCred,
      sshPublicKey: normalizeSshPublicKey('ssh-ed25519 DIFFERENTKEYBYTES someoneelse@host'),
    });
    const res = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', authKey: PUBKEY }), res);
    expect(res.statusCode).toBe(403);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('malformed pubkey → 403 (no lookup)', async () => {
    const res = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', authKey: 'junk' }), res);
    expect(res.statusCode).toBe(403);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('WRONG path secret → 401 (random internet cannot POST) — no Redis lookup (DoS-safe ordering)', async () => {
    const res = makeRes();
    await handler(makeReq({ secret: 'nope', authKey: PUBKEY }), res);
    expect(res.statusCode).toBe(401);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('MISSING path secret → 401 (no lookup)', async () => {
    const res = makeRes();
    await handler(makeReq({ authKey: PUBKEY }), res);
    expect(res.statusCode).toBe(401);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('UNCONFIGURED sish secret (env unset) → 503 (inert until provisioned), even with a path secret', async () => {
    mockEnv.APPS_DEV_TUNNEL_SISH_SECRET = undefined;
    const res = makeRes();
    await handler(makeReq({ secret: 'anything', authKey: PUBKEY }), res);
    expect(res.statusCode).toBe(503);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('non-POST → 405', async () => {
    const res = makeRes();
    await handler(makeReq({ secret: 'sish-shared-secret', method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });
});

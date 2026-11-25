import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../../../../test/sys-redis.fake';

// No session is minted, re-signed or copied to the host-only slot from claims the verifier accepted without
// reading the session store: the caller gets a retryable 503 (or, on the page path, no copy), and the same
// claims once confirmed mint as before.

const h = vi.hoisted(() => {
  // Secure cookie naming, so the host-only and shared slots have different names.
  process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
  return {
    sys: undefined as unknown as SysRedisFake,
    minted: [] as Record<string, unknown>[],
    live: {} as unknown,
    shared: {} as unknown,
  };
});

// No user rows: the account checks at each mint pass, as for an ordinary account.
vi.mock('$lib/server/db/db', async () => ({
  db: (await import('../../../../test/kysely-fake')).createKyselyFake({}),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => true,
  maybeCreateSessionSigner: () => ({
    maxAge: 30 * 24 * 60 * 60,
    mintSessionToken: async (payload: Record<string, unknown>) => {
      h.minted.push(payload);
      return 'minted-token';
    },
  }),
}));
vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/auth/verifier', () => ({
  verifier: { verifyToken: async () => h.live },
  signatureVerifier: { verifyToken: async () => h.shared },
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id }),
}));

import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import { mintSession, reissueSession } from '../session';
import { preUpgradeHubSession, upgradeHubSession } from '../legacy-upgrade';
import { markUnconfirmedSession } from '../unconfirmed-session';

const claims = (): SessionClaims =>
  ({ sub: '7', jti: 'j1', sid: 'family-a', iat0: Date.now(), signedAt: Date.now() } as never);
const unconfirmed = () => {
  const c = claims();
  markUnconfirmedSession(c);
  return c;
};
const statusOf = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status
  );
const cookies = () =>
  ({ get: () => undefined, set: vi.fn(), delete: vi.fn(), getAll: () => [] } as never);

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.minted = [];
});

describe('mintSession', () => {
  it('answers 503 for a parent accepted without reading the session store', async () => {
    expect(await statusOf(mintSession({ id: 7 } as never, { parent: unconfirmed() }))).toBe(503);
    expect(h.minted).toHaveLength(0);
  });

  it('mints from the same parent once confirmed', async () => {
    expect(await statusOf(mintSession({ id: 7 } as never, { parent: claims() }))).toBe(200);
    expect(h.minted).toHaveLength(1);
  });
});

describe('reissueSession', () => {
  it('answers 503 for claims accepted without reading the session store', async () => {
    expect(await statusOf(reissueSession(unconfirmed(), 7, 'j1'))).toBe(503);
    expect(h.minted).toHaveLength(0);
  });

  it('re-signs the same claims once confirmed', async () => {
    expect(await statusOf(reissueSession(claims(), 7, 'j1'))).toBe(200);
    expect(h.minted).toHaveLength(1);
  });
});

describe('preUpgradeHubSession (/authorize)', () => {
  it('answers 503 for a session accepted without reading the session store', async () => {
    expect(await statusOf(preUpgradeHubSession(cookies(), unconfirmed(), { id: 7 } as never))).toBe(
      503
    );
    expect(h.minted).toHaveLength(0);
  });

  it('copies the same session once confirmed', async () => {
    expect(await statusOf(preUpgradeHubSession(cookies(), claims(), { id: 7 } as never))).toBe(200);
    expect(h.minted).toHaveLength(1);
  });
});

describe('upgradeHubSession (every page request)', () => {
  beforeEach(() => {
    h.shared = claims();
  });

  it('copies nothing for a session accepted without reading the session store', async () => {
    h.live = unconfirmed();
    expect(await upgradeHubSession(cookies(), 'shared-token')).toBeNull();
    expect(h.minted).toHaveLength(0);
  });

  it('copies the same session once confirmed', async () => {
    h.live = claims();
    expect(await upgradeHubSession(cookies(), 'shared-token')).toBe('minted-token');
    expect(h.minted).toHaveLength(1);
  });
});

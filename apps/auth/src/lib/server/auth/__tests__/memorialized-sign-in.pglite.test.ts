import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims, SessionUser } from '@civitai/auth';
import type { Cookies } from '@sveltejs/kit';

/**
 * A memorialized account gets no session from any sign-in, switch or re-sign, whatever the caller's user
 * object or the session cache says: each mint reads the account's row. A moderator's impersonation of it
 * is the one session still minted. Runs the real session, user and refusal modules over Postgres.
 */

const h = vi.hoisted(() => ({
  db: { current: null as unknown },
  mintSessionToken: vi.fn(async () => 'minted-token'),
  logToAxiom: vi.fn(async () => undefined),
  canSwitch: vi.fn(async () => true),
  verifyToken: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('$lib/server/db/db', () => ({
  get db() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => false,
  sessionCookieName: () => 'civ-token',
  maybeCreateSessionSigner: () => ({ mintSessionToken: h.mintSessionToken, maxAge: 1234 }),
}));
vi.mock('$lib/server/auth/registry', () => ({
  sessions: { trackToken: vi.fn(async () => undefined) },
}));
vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifyToken: h.verifyToken } }));
vi.mock('$lib/server/auth/cookie', () => ({ cookieDomain: () => undefined }));
vi.mock('$lib/server/auth/device', () => ({
  getOrCreateDeviceId: () => 'device-1',
  getDeviceId: () => 'device-1',
  linkAccount: vi.fn(async () => 'none'),
  rotateDeviceId: vi.fn(),
  canSwitch: h.canSwitch,
  touchAccount: vi.fn(async () => undefined),
  rollDeviceCookie: vi.fn(),
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: h.logToAxiom, logAxiomError: vi.fn() }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null, getSysRedis: () => null }));
// The cached user, as it reads before the memorialization reached the cache: no marker on it.
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id, username: `u${id}` }),
}));

const { establishSession, mintSession, mintUserSession, reissueSession } = await import(
  '../session'
);
const { findOrCreateUser, findOrCreateUserByEmail } = await import('../users');
const { MEMORIALIZED_SIGN_IN_REFUSED } = await import('../account-refusal');
const { POST: switchPost } = await import('../../../../routes/api/auth/switch/+server');
const { actions: authorizeActions } = await import(
  '../../../../routes/login/oauth/authorize/+page.server'
);

const MEMORIALIZED = 4;
const ACCOUNT = 5100;
const OTHER = 5200;
const MODERATOR = 5300;
const EMAIL = 'holder@example.com';

const PRELUDE = `
  CREATE TABLE "User" (
    "id" SERIAL PRIMARY KEY, "username" TEXT UNIQUE, "name" TEXT, "email" TEXT UNIQUE,
    "emailVerified" TIMESTAMP, "image" TEXT, "meta" JSONB NOT NULL DEFAULT '{}',
    "flags" INTEGER NOT NULL DEFAULT 0, "isModerator" BOOLEAN, "showNsfw" BOOLEAN NOT NULL DEFAULT false,
    "blurNsfw" BOOLEAN NOT NULL DEFAULT true, "browsingLevel" INTEGER NOT NULL DEFAULT 1,
    "onboarding" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "deletedAt" TIMESTAMP, "muted" BOOLEAN NOT NULL DEFAULT false, "bannedAt" TIMESTAMP
  );
  CREATE TABLE "Account" (
    "userId" INTEGER NOT NULL, "type" TEXT, "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL, "scope" TEXT
  );
`;

let pg: PGlite;

function pgliteDialect(db: PGlite): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await db.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not streamed');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

const seed = (id: number, flags: number, email: string | null = null) =>
  pg.query(
    `INSERT INTO "User" ("id", "username", "email", "emailVerified", "flags") VALUES ($1, $2, $3, now(), $4)`,
    [id, `u${id}`, email, flags]
  );
const setFlags = (id: number, flags: number) =>
  pg.query(`UPDATE "User" SET "flags" = $2 WHERE "id" = $1`, [id, flags]);

function cookieStub() {
  const set = vi.fn();
  return { set, cookies: { get: () => undefined, set, delete: vi.fn() } as unknown as Cookies };
}

const user = (id: number) => ({ id, username: `u${id}` } as unknown as SessionUser);
const impersonation: SessionClaims = {
  sub: String(OTHER),
  jti: 'imp-jti',
  sid: 'fam-imp',
  iat0: Date.now(),
  impersonatedBy: MODERATOR,
  impExp: Date.now() + 60_000,
} as SessionClaims;
const plain = (sub: number): SessionClaims =>
  ({ sub: String(sub), jti: 'plain-jti', sid: 'fam-plain', iat0: Date.now() } as SessionClaims);

const refusedWithMemorialCopy = {
  status: 403,
  body: { message: MEMORIALIZED_SIGN_IN_REFUSED },
};

async function status(run: () => unknown): Promise<number | undefined> {
  try {
    const res = (await run()) as Response | undefined;
    return res?.status;
  } catch (e) {
    return (e as { status?: number }).status;
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.verifyToken.mockResolvedValue(null);
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  h.db.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  h.db.current = null;
  await pg.close();
});

describe('signing in to a memorialized account', () => {
  it('an email link signs an ordinary account in (positive control)', async () => {
    await seed(ACCOUNT, 0, EMAIL);
    const { cookies, set } = cookieStub();

    await establishSession(cookies, await findOrCreateUserByEmail(EMAIL));

    expect(set).toHaveBeenCalledWith('civ-token', 'minted-token', expect.anything());
  });

  it('an email link is refused with the memorial message, and no cookie is set', async () => {
    await seed(ACCOUNT, MEMORIALIZED, EMAIL);
    const { cookies, set } = cookieStub();

    await expect(
      establishSession(cookies, await findOrCreateUserByEmail(EMAIL))
    ).rejects.toMatchObject(refusedWithMemorialCopy);
    expect(set).not.toHaveBeenCalled();
    expect(h.mintSessionToken).not.toHaveBeenCalled();
    expect(h.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'memorialized-account-refused', type: 'info' })
    );
  });

  it('a provider sign-in is refused, and an ordinary account signs in (control)', async () => {
    const profile = { providerAccountId: 'g-1', email: EMAIL, emailVerified: true };
    await seed(ACCOUNT, MEMORIALIZED, EMAIL);
    const refused = cookieStub();
    await expect(
      establishSession(refused.cookies, await findOrCreateUser('google', profile))
    ).rejects.toMatchObject(refusedWithMemorialCopy);
    expect(refused.set).not.toHaveBeenCalled();

    await setFlags(ACCOUNT, 0);
    const control = cookieStub();
    await establishSession(control.cookies, await findOrCreateUser('google', profile));
    expect(control.set).toHaveBeenCalledWith('civ-token', 'minted-token', expect.anything());
  });

  it('a direct mint is refused, and lifts as soon as the flag is cleared', async () => {
    await seed(ACCOUNT, MEMORIALIZED);
    await expect(mintUserSession(user(ACCOUNT))).rejects.toMatchObject(refusedWithMemorialCopy);

    await setFlags(ACCOUNT, 0);
    await expect(mintUserSession(user(ACCOUNT))).resolves.toBe('minted-token');
  });
});

describe('impersonating a memorialized account', () => {
  beforeEach(() => seed(ACCOUNT, MEMORIALIZED));

  it('an impersonation mint works', async () => {
    await expect(
      mintUserSession(user(ACCOUNT), { parent: plain(MODERATOR), impersonatedBy: MODERATOR })
    ).resolves.toBe('minted-token');
  });

  it("a spoke session minted from the impersonation's lineage works", async () => {
    await expect(
      mintSession(user(ACCOUNT), { parent: { ...impersonation, sub: String(ACCOUNT) } })
    ).resolves.toMatchObject({ token: 'minted-token' });
  });

  it('a mint that clears the impersonation is refused, as a switch from it does', async () => {
    await expect(
      mintUserSession(user(ACCOUNT), { parent: impersonation, clearImpersonation: true })
    ).rejects.toMatchObject(refusedWithMemorialCopy);
  });

  it('a sign-in on a browser holding an impersonation is refused; an ordinary account signs in', async () => {
    h.verifyToken.mockResolvedValue(impersonation);
    const holding = () => {
      const stub = cookieStub();
      (stub.cookies as unknown as { get: () => string }).get = () => 'impersonation-token';
      return stub;
    };
    const refused = holding();
    await expect(establishSession(refused.cookies, user(ACCOUNT))).rejects.toMatchObject(
      refusedWithMemorialCopy
    );
    expect(refused.set).not.toHaveBeenCalled();

    await setFlags(ACCOUNT, 0);
    const control = holding();
    await establishSession(control.cookies, user(ACCOUNT));
    expect(control.set).toHaveBeenCalledWith('civ-token', 'minted-token', expect.anything());
  });
});

describe('switching to a memorialized account from an impersonation', () => {
  const locals = () => ({
    user: { id: OTHER },
    deviceId: 'device-1',
    session: impersonation,
    impersonatedBy: MODERATOR,
  });

  const switchTo = (target: number) => {
    const { cookies } = cookieStub();
    return status(() =>
      switchPost({
        request: new Request('https://auth.civitai.com/api/auth/switch', {
          method: 'POST',
          body: JSON.stringify({ userId: target }),
        }),
        cookies,
        locals: locals(),
      } as never)
    );
  };

  const pickInAuthorize = async (target: number) => {
    const { cookies, set } = cookieStub();
    const body = new FormData();
    body.set('userId', String(target));
    body.set('client_id', 'game-frame');
    const code = await status(() =>
      authorizeActions.switch({
        request: new Request('https://auth.civitai.com/login/oauth/authorize', {
          method: 'POST',
          body,
        }),
        cookies,
        locals: locals(),
        url: new URL('https://auth.civitai.com/login/oauth/authorize?client_id=game-frame'),
      } as never)
    );
    return { code, set };
  };

  beforeEach(async () => {
    await seed(OTHER, 0);
    await seed(ACCOUNT, MEMORIALIZED);
    await seed(ACCOUNT + 1, 0);
  });

  it('/api/auth/switch is refused, and switches to an ordinary account (control)', async () => {
    expect(await switchTo(ACCOUNT)).toBe(403);
    expect(await switchTo(ACCOUNT + 1)).toBe(200);
  });

  it("the authorize screen's account pick is refused, and picks an ordinary account (control)", async () => {
    const refused = await pickInAuthorize(ACCOUNT);
    expect(refused.code).toBe(403);
    expect(refused.set).not.toHaveBeenCalled();

    const control = await pickInAuthorize(ACCOUNT + 1);
    expect(control.code).toBe(303);
    expect(control.set).toHaveBeenCalledWith('civ-token', 'minted-token', expect.anything());
  });
});

describe('re-signing a memorialized account', () => {
  it('is refused for its own session and allowed for an impersonation of it', async () => {
    await seed(ACCOUNT, MEMORIALIZED);
    await expect(reissueSession(plain(ACCOUNT), ACCOUNT, 'plain-jti')).rejects.toMatchObject(
      refusedWithMemorialCopy
    );
    await expect(
      reissueSession({ ...impersonation, sub: String(ACCOUNT) }, ACCOUNT, 'imp-jti')
    ).resolves.toBe('minted-token');
  });

  it('re-signs an ordinary account (positive control)', async () => {
    await seed(ACCOUNT, 0);
    await expect(reissueSession(plain(ACCOUNT), ACCOUNT, 'plain-jti')).resolves.toBe(
      'minted-token'
    );
  });
});

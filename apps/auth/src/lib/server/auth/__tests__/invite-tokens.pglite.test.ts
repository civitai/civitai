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

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../../db/db', () => ({
  get db() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../axiom', () => ({ logAxiomError: vi.fn() }));

const { consumeInviteToken, issueInvite, findInvite, INVITE_TTL_MS } = await import(
  '../invite-tokens'
);

const PRELUDE = `
  CREATE TABLE "OauthInvite" (
    "tokenHash" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "email" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

const INVITE = {
  clientId: 'advertising',
  email: 'bob@example.com',
  returnUrl: 'https://advertising.civitai.com/invite/abc',
};

/**
 * Issue an invite whose delivery just captures the raw token, as the email would carry it. The clock moves
 * on a millisecond first, so each invite is strictly newer than the last, as successive requests are.
 */
async function createInviteToken(invite: typeof INVITE) {
  vi.setSystemTime(Date.now() + 1);
  let token = '';
  await issueInvite(invite, async (t) => {
    token = t;
  });
  return { token };
}

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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  vi.useRealTimers();
  dbHandle.current = null;
  await pg.close();
});

describe('invite tokens', () => {
  it('signs in once: a second use of the same link is refused', async () => {
    const { token } = await createInviteToken(INVITE);
    await expect(consumeInviteToken(token)).resolves.toEqual(INVITE);
    await expect(consumeInviteToken(token)).resolves.toBeNull();
  });

  it('survives being looked at: showing the invite does not spend it', async () => {
    const { token } = await createInviteToken(INVITE);
    await expect(findInvite(token)).resolves.toEqual(INVITE);
    await expect(consumeInviteToken(token)).resolves.toEqual(INVITE);
  });

  it('refuses an unknown token', async () => {
    await createInviteToken(INVITE);
    await expect(consumeInviteToken('not-a-token')).resolves.toBeNull();
  });

  it('refuses a link past its TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { token } = await createInviteToken(INVITE);
    vi.setSystemTime(Date.now() + INVITE_TTL_MS + 1000);
    await expect(findInvite(token)).resolves.toBeNull();
    await expect(consumeInviteToken(token)).resolves.toBeNull();
  });

  it('a resend replaces the earlier link for the same destination only', async () => {
    const first = await createInviteToken(INVITE);
    const otherAccount = await createInviteToken({
      ...INVITE,
      returnUrl: 'https://advertising.civitai.com/invite/def',
    });
    const resent = await createInviteToken(INVITE);

    await expect(consumeInviteToken(first.token)).resolves.toBeNull();
    await expect(consumeInviteToken(resent.token)).resolves.toEqual(INVITE);
    await expect(consumeInviteToken(otherAccount.token)).resolves.not.toBeNull();
  });

  it('a resend to the same address in another letter case still replaces the earlier link', async () => {
    const first = await createInviteToken(INVITE);
    await createInviteToken({ ...INVITE, email: 'Bob@example.com' });
    await expect(consumeInviteToken(first.token)).resolves.toBeNull();
  });

  it('a resend whose email fails to send leaves the earlier link working and no new one', async () => {
    const first = await createInviteToken(INVITE);
    let failedToken = '';
    await expect(
      issueInvite(INVITE, async (t) => {
        failedToken = t;
        throw new Error('SMTP refused');
      })
    ).rejects.toThrow('SMTP refused');

    await expect(consumeInviteToken(failedToken)).resolves.toBeNull();
    await expect(consumeInviteToken(first.token)).resolves.toEqual(INVITE);
  });

  it('of two overlapping sends of one invite, the newer link survives', async () => {
    let older = '';
    let newer = '';
    await issueInvite(INVITE, async (t) => {
      older = t;
      ({ token: newer } = await createInviteToken(INVITE));
    });
    await expect(consumeInviteToken(older)).resolves.toBeNull();
    await expect(consumeInviteToken(newer)).resolves.toEqual(INVITE);
  });

  it('of two overlapping sends in the same millisecond, exactly one link survives', async () => {
    const tokens: string[] = [];
    await issueInvite(INVITE, async (a) => {
      tokens.push(a);
      await issueInvite(INVITE, async (b) => {
        tokens.push(b);
      });
    });
    const live = await Promise.all(tokens.map((t) => consumeInviteToken(t)));
    expect(live.filter(Boolean)).toHaveLength(1);
  });

  it('reports a sent invite as sent even if cleaning up older links fails afterwards', async () => {
    let token = '';
    await expect(
      issueInvite(INVITE, async (t) => {
        token = t;
        // Makes the cleanup DELETE, which runs after delivery, fail.
        await pg.exec(`ALTER TABLE "OauthInvite" RENAME TO "OauthInviteAway"`);
      })
    ).resolves.toEqual({ expiresAt: expect.any(Date) });

    await pg.exec(`ALTER TABLE "OauthInviteAway" RENAME TO "OauthInvite"`);
    await expect(consumeInviteToken(token)).resolves.toEqual(INVITE);
  });

  it('stores only a hash of the token', async () => {
    const { token } = await createInviteToken(INVITE);
    const { rows } = await pg.query<{ tokenHash: string }>(`SELECT "tokenHash" FROM "OauthInvite"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token);
  });
});

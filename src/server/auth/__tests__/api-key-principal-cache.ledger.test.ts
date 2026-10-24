import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { REDIS_KEYS } from '~/server/redis/client';
import type * as KeyGenerator from '~/server/utils/key-generator';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as ApiKeySpend from '~/server/http/orchestrator/api-key-spend';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserService from '~/server/services/user.service';
import { OnboardingSteps } from '~/server/common/enums';
import { stripCodeComments } from '~/test-utils/strip-code-comments';

/**
 * 🔴 The bearer path caches ApiKey rows (api-key-principal-cache.ts). A write that revokes or changes
 * a cached row and does not evict it leaves the old credential working for up to the cache TTL.
 *
 * So this file holds (1) a LEDGER of every ApiKey write in the repository — Prisma, Kysely and raw
 * SQL, in the main app and the sibling apps that share the table — each with the reason it is
 * safe, and (2) a behavioural test for every write that has to evict. The ledger fails when the set
 * of writes GROWS (a new writer nobody has classified) and when it SHRINKS (a listed writer moved or
 * was removed, so its reason no longer describes anything).
 */

const { hubSession, generateSecretHash } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  generateSecretHash: (key: string) => `hash-of-${key}`,
}));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash,
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
}));
vi.mock('~/server/http/orchestrator/api-key-spend', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeySpend>()),
  bustBuzzLimitCache: vi.fn(async () => undefined),
  deleteAuthSubject: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  invalidateCivitaiUser: vi.fn(async () => undefined),
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  addApiKey: vi.fn(async () => 'minted-api-key'),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy: vi.fn(() => ({})),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
  computeUserFeatureFlagsOverlay: vi.fn(() => ({})),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: vi.fn(async () => ({ features: {} })),
}));

const { getSessionFromBearerToken } = await import('~/server/auth/bearer-token');
const { deleteApiKey, deleteApiKeys, setApiKeyBuzzLimit } = await import(
  '~/server/services/api-key.service'
);
const orchestratorKeyRoute = (await import('~/pages/api/user/orchestrator-key'))
  .default as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

// ---------------------------------------------------------------------------------------------
// (1) The ledger
// ---------------------------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../../../..');
const PATTERNS = [
  /\.apiKey\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g,
  // Kysely, with or without an alias: `.deleteFrom('ApiKey')`, `.updateTable('ApiKey as k')`.
  /\.(insertInto|updateTable|deleteFrom|mergeInto)\(\s*['"]ApiKey(\s+as\s+\w+)?['"]/g,
  // Raw SQL, any case, quoted or not, with an optional schema: `UPDATE public."ApiKey"`.
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+("?\w+"?\.)?"?apikey"?(?![\w"])/gi,
];
const NOT_CACHED =
  'touches OAuth rows only (clientId set, type Access/Refresh); the cache never holds those';
const WORKER_ONLY =
  'touches type Worker rows only; the bearer path never selects that type, so never caches one';
const LEDGER: Record<string, { count: number; why: string }> = {
  'src/server/auth/bearer-token.ts': {
    count: 1,
    why: 'lastUsedAt only; nothing the bearer path decides on. Throttled per key per hour.',
  },
  'src/server/services/api-key.service.ts': {
    count: 5,
    why:
      'create: a new key, and misses are never cached. setApiKeyBuzzLimit update and the ' +
      'deleteApiKeys helper: evict (tested below). getTemporaryUserApiKey x2: housekeeping of the ' +
      "caller's own rotated generation keys, not a revocation; the first only removes keys within " +
      '30 s of their own expiry (entries never outlive expiresAt), the second a legacy key name. ' +
      'Accepted: such a key can keep working for at most the cache TTL after the clean-up.',
  },
  'src/server/routers/oauth-consent.router.ts': { count: 1, why: NOT_CACHED },
  'src/server/services/blocks/oauth-consent-sync.service.ts': { count: 1, why: NOT_CACHED },
  'apps/auth/src/lib/server/oauth/model.ts': { count: 1, why: NOT_CACHED },
  'apps/auth/src/lib/server/oauth/token-helpers.ts': { count: 1, why: 'insert: OAuth rows' },
  'apps/auth/src/routes/api/auth/oauth/revoke/+server.ts': { count: 2, why: NOT_CACHED },
  'apps/auth/src/lib/server/oauth/worker-grant.ts': { count: 2, why: WORKER_ONLY },
  'apps/auth/src/lib/server/oauth/worker-admin.ts': { count: 1, why: WORKER_ONLY },
  'apps/training-studio/src/lib/server/orchestrator-token.ts': {
    count: 2,
    why:
      'insert, and a delete of its own system keys within 30 s of expiry; a cached entry never ' +
      'outlives expiresAt.',
  },
};

function scan(root = ROOT) {
  const files = globSync('{src,apps,packages,scripts}/**/*.{ts,tsx,js,mjs,cjs,svelte}', {
    cwd: root,
    exclude: (f) =>
      /node_modules|\.svelte-kit|(^|[\\/])dist([\\/]|$)/.test(typeof f === 'string' ? f : f.name),
  })
    .map((f) => f.split(path.sep).join('/'))
    .filter(
      (f) =>
        !/(__tests__|\.test\.|\.spec\.|\/migrations\/)/.test(f) &&
        statSync(path.join(root, f)).isFile()
    );
  const found: Record<string, number> = {};
  for (const f of files) {
    const text = stripCodeComments(readFileSync(path.join(root, f), 'utf8'));
    const n = PATTERNS.reduce((sum, re) => sum + (text.match(re) ?? []).length, 0);
    if (n) found[f] = n;
  }
  return { files, found };
}

describe('ApiKey write ledger', () => {
  const { files, found } = scan();

  it('scans the source tree (instrument control)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('apps/auth/src/routes/api/auth/oauth/revoke/+server.ts');
  });

  it('each pattern still matches what it was written for (instrument control)', () => {
    const [prisma, kysely, raw] = PATTERNS;
    expect('dbWrite.apiKey.deleteMany({').toMatch(new RegExp(prisma.source));
    // A chain split across lines, as prettier formats a long one.
    expect('dbWrite.apiKey\n      .update({').toMatch(new RegExp(prisma.source));
    expect(".deleteFrom('ApiKey')").toMatch(new RegExp(kysely.source));
    expect('DELETE FROM "ApiKey" WHERE').toMatch(new RegExp(raw.source, 'i'));
    expect('trpc.apiKey.delete.useMutation(').not.toMatch(new RegExp(prisma.source));
  });

  it('counts every write shape in a real file, and none of the comments (positive control)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apikey-ledger-'));
    try {
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(
        path.join(dir, 'src', 'fixture.ts'),
        [
          "const glob = 'apps/*/src';", // opens a fake block comment for a naive stripper
          'await dbWrite.apiKey.delete({ where });', // 1
          'await tx.apiKey',
          '  .updateMany({ where, data });', // 2
          "await db.deleteFrom('ApiKey').execute();", // 3
          "await db.updateTable('ApiKey as k').set({}).execute();", // 4
          'await sql`DELETE FROM "ApiKey" WHERE id = 1`;', // 5
          'await sql`update public."ApiKey" set name = 1`;', // 6
          'await sql`insert into apikey (id) values (1)`;', // 7
          '/* opens and closes */ await db.apiKey.delete({ where });', // 8
          'doSomething(); /* a comment opened after code',
          ' */ await db.apiKey.upsert({ where });', // 9: code after a close on a later line
          '/* dbWrite.apiKey.delete({ where }) in a block comment */',
          '// dbWrite.apiKey.delete({ where }) in a line comment',
          ' * dbWrite.apiKey.delete({ where }) in a JSDoc line',
          "await db.selectFrom('ApiKey').execute();", // a read
          'await sql`UPDATE "ApiKeyUsage" SET n = 1`;', // another table
        ].join('\n')
      );
      expect(scan(dir).found).toEqual({ 'src/fixture.ts': 9 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists every ApiKey write in the repository, no more and no fewer', () => {
    expect(found).toEqual(
      Object.fromEntries(Object.entries(LEDGER).map(([f, { count }]) => [f, count]))
    );
  });
});

// ---------------------------------------------------------------------------------------------
// (2) Every write that must evict, behaviourally
// ---------------------------------------------------------------------------------------------

const T0 = new Date('2026-10-17T12:00:00.000Z');
type Row = {
  id: number;
  key: string;
  name: string;
  userId: number;
  tokenScope: number;
  lastUsedAt: Date | null;
  buzzLimit: { limit: number } | null;
  clientId: string | null;
  type: string;
  expiresAt: Date | null;
};
let rows: Row[];
const seed = (): Row[] => [
  {
    id: 51,
    key: 'hash-of-personal',
    name: 'my script',
    userId: 501,
    tokenScope: 0b0101,
    lastUsedAt: T0,
    buzzLimit: { limit: 100 },
    clientId: null,
    type: 'User',
    expiresAt: null,
  },
  {
    id: 52,
    key: 'hash-of-orchestrator',
    name: 'orchestrator-key:civitai.com',
    userId: 501,
    tokenScope: 0b1010,
    lastUsedAt: T0,
    buzzLimit: null,
    clientId: null,
    type: 'System',
    expiresAt: null,
  },
];
const matches = (row: Row, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([field, cond]) => {
    if (field === 'AND') return (cond as Record<string, unknown>[]).every((c) => matches(row, c));
    if (cond && typeof cond === 'object' && 'in' in cond)
      return (cond as { in: unknown[] }).in.includes(row[field as keyof Row]);
    return row[field as keyof Row] === cond;
  });

const dbReads = () => dbMock.dbWrite.apiKey.findFirst.mock.calls.length;
let store: ReturnType<typeof installFakeCacheRedis>;
const tombstoned = (hash: string) =>
  (store.peek(`${REDIS_KEYS.CACHES.API_KEY_PRINCIPAL}:${hash}`) as { revoked?: true })?.revoked ===
  true;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  hubSession.current = null;
  rows = seed();
  store = installFakeCacheRedis();
  dbMock.dbWrite.apiKey.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { key: string };
  }) => {
    const row = rows.find((r) => r.key === where.key);
    return row ? { ...row } : null;
  }) as never);
  dbMock.dbWrite.apiKey.findMany.mockImplementation((async ({
    where,
  }: {
    where: Record<string, unknown>;
  }) =>
    rows
      .filter((r) => matches(r, where))
      .map(({ id, key, userId }) => ({ id, key, userId }))) as never);
  dbMock.dbWrite.apiKey.deleteMany.mockImplementation((async ({
    where,
  }: {
    where: Record<string, unknown>;
  }) => {
    const before = rows.length;
    rows = rows.filter((r) => !matches(r, where));
    return { count: before - rows.length };
  }) as never);
  dbMock.dbWrite.apiKey.update.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number };
    data: Partial<Row>;
  }) => {
    const row = rows.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return { ...row };
  }) as never);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Use the key once so its row is cached, then make sure the cache now answers for it. */
async function warm(token: string) {
  await getSessionFromBearerToken(token);
  const reads = dbReads();
  expect(await getSessionFromBearerToken(token)).not.toBeNull();
  expect(dbReads()).toBe(reads); // served from the cache
}

describe('writes that evict the bearer cache', () => {
  it('control: a delete that bypasses the helper leaves the cached key working', async () => {
    await warm('personal');
    rows = rows.filter((r) => r.id !== 51);
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(51);
  });

  it('deleteApiKey (the user deleting a key) stops it on the next request', async () => {
    await warm('personal');
    await deleteApiKey({ id: 51, userId: 501 });
    expect(tombstoned('hash-of-personal')).toBe(true);
    expect(await getSessionFromBearerToken('personal')).toBeNull();
  });

  it("deleteApiKey also revokes the user's tokens in the orchestrator's auth cache", async () => {
    const { revokeCivitaiUserTokens } = await import('~/server/services/orchestrator/civitai');
    await deleteApiKey({ id: 51, userId: 501 });
    expect(revokeCivitaiUserTokens).toHaveBeenCalledWith({ userId: 501 });
  });

  it('deleteApiKeys evicts every row it deletes and only those', async () => {
    await warm('personal');
    await warm('orchestrator');
    await deleteApiKeys({ userId: 501, type: 'System' });
    expect(tombstoned('hash-of-orchestrator')).toBe(true);
    expect(tombstoned('hash-of-personal')).toBe(false);
    expect(await getSessionFromBearerToken('orchestrator')).toBeNull();
    expect((await getSessionFromBearerToken('personal'))?.apiKeyId).toBe(51);
  });

  it('a failed tombstone write does not fail the delete, and the row is gone', async () => {
    await warm('personal');
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    redisMock.redis.packed.set.mockImplementation((() => {
      throw new Error('client not connected');
    }) as never);
    await expect(deleteApiKey({ id: 51, userId: 501 })).resolves.toMatchObject({ count: 1 });
    expect(rows.map((r) => r.id)).toEqual([52]);
  });

  it('setApiKeyBuzzLimit serves the new limit on the next request', async () => {
    await warm('personal');
    const updated = await setApiKeyBuzzLimit({
      id: 51,
      userId: 501,
      buzzLimit: { limit: 9 } as never,
    });
    expect(updated).not.toHaveProperty('key');
    expect(tombstoned('hash-of-personal')).toBe(true);
    expect((await getSessionFromBearerToken('personal'))?.buzzLimit).toEqual({ limit: 9 });
  });

  it('GET /api/user/orchestrator-key (regenerate) stops the old orchestrator key', async () => {
    await warm('orchestrator');
    hubSession.current = {
      user: {
        id: 501,
        username: 'someone',
        bannedAt: null,
        muted: false,
        onboarding: OnboardingSteps.Buzz,
        emailVerified: new Date('2026-01-01'),
      },
    };
    let body: unknown;
    const res = {
      status: () => res,
      json: (v: unknown) => ((body = v), res),
      send: () => res,
      setHeader: () => res,
      getHeader: () => undefined,
      end: () => res,
      on: () => res,
      once: () => res,
    } as unknown as NextApiResponse;
    const req = {
      method: 'GET',
      url: '/api/user/orchestrator-key',
      headers: { host: 'civitai.com' },
      query: {},
      cookies: {},
    } as unknown as NextApiRequest;
    await orchestratorKeyRoute(req, res);
    expect(body).toEqual({ key: 'minted-api-key' });
    expect(tombstoned('hash-of-orchestrator')).toBe(true);
    expect(await getSessionFromBearerToken('orchestrator')).toBeNull();
  });
});

import { S3Client } from '@aws-sdk/client-s3';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppForkService from '~/server/services/blocks/app-fork.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * FORKABLE APPS, PR 3 — `startAppFork` and the fork session, against the canonical db / redis /
 * env mocks with the REAL zip build, the REAL S3 presigner (only `send` is stubbed) and the REAL
 * App Assistant account gate.
 *
 * Claims, each pinned with the exact error:
 *   - every refusal, in the order the module header lists;
 *   - the seed: built from the parent's LATEST APPROVED commit (never HEAD), files at the archive
 *     root, secrets / dependencies / build output absent BY NAME, `blockId` rewritten;
 *   - the presigned URL: the configured host, https, no port, 10 minutes;
 *   - the fork session is recorded (and is the slug's reservation), released on failure;
 *   - slugs: valid, unique against the database and the session store;
 *   - nothing is written to the database (no approvals, scopes, goods, entitlements).
 */

const m = vi.hoisted(() => ({
  features: { appBlocks: true, appAssistant: true } as Record<string, boolean>,
  forkFlag: true,
  summary: vi.fn(),
  forkable: vi.fn(),
  reconstruct: vi.fn(),
  setProvenance: vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  mintAppToken: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: vi.fn(async () => undefined),
  deleteAuthSubject: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/dev-tunnel-frame.service', () => ({
  resolveDevTunnelFrame: vi.fn(),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => m.features),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksForkEnabled: vi.fn(async () => m.forkFlag),
  isAppBlocksDevTunnelEnabled: vi.fn(async () => false),
}));
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  getStoreVisibleListingSummary: m.summary,
}));
vi.mock('~/server/services/blocks/app-fork.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppForkService>()),
  readListingForkable: m.forkable,
  setPublishRequestForkProvenance: m.setProvenance,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  reconstructBundleFromForgejo: m.reconstruct,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { FORKABLE_OFFSITE_MESSAGE } from '~/server/services/blocks/app-fork.service';
import {
  FORK_BUSY_MESSAGE,
  FORK_NOT_ALLOWED_MESSAGE,
  FORK_NO_APPROVED_VERSION_MESSAGE,
  FORK_PARENT_UNAVAILABLE_MESSAGE,
  FORK_RATE_LIMITED_MESSAGE,
  FORK_SETTING_DISABLED_MESSAGE,
  FORK_SOURCE_UNREADABLE_MESSAGE,
  FORK_UNAVAILABLE_HERE_MESSAGE,
} from '~/shared/constants/app-fork.constants';
import type { SessionUser } from '~/types/session';

const {
  FORK_SESSION_TTL_SECONDS,
  applyForkSessionToFirstPublishRequest,
  forkSeedExclusionReason,
  forkSlugFor,
  getForkSessionForUser,
  isValidForkSlug,
  startAppFork,
} = await import('~/server/services/blocks/app-fork-start.service');

// ---------------------------------------------------------------------------
// Fixtures — pairwise distinct, and distinct from every constant the assertions name.
// ---------------------------------------------------------------------------

const SEED_HOST = 'seeds.fork-store.test';
const PARENT_LISTING = 'apl_parent_5101';
const PARENT_BLOCK = 'ab_parent_5102';
const PARENT_SLUG = 'pixel-garden';
const PARENT_NAME = 'Pixel Garden';
const APPROVED_SHA = 'c0ffee'.repeat(6) + 'beef'; // 40 hex
const HEAD_SHA = 'deadbeef'.repeat(5); // what a branch HEAD would be — never used
const FORKER_ID = 8101;
const OTHER_USER_ID = 8102;

const forker = {
  id: FORKER_ID,
  username: 'forker',
  isModerator: false,
  onboarding: 0x1f,
  emailVerified: new Date('2026-01-01T00:00:00Z'),
} as unknown as SessionUser;

/** The parent's approved source, including every kind of file a seed must leave out. */
const PARENT_FILES: Record<string, string> = {
  'block.manifest.json': JSON.stringify({
    blockId: PARENT_SLUG,
    name: PARENT_NAME,
    version: '1.4.0',
    scopes: ['ai:write:budgeted'],
    // The PARENT's repository — must not become the fork's "Source" link.
    repository: 'https://github.com/parent-author/pixel-garden',
  }),
  'README.md': '# Pixel Garden',
  'src/index.ts': 'export const garden = 1;',
  'src/build/helper.ts': 'export const nestedBuildDirIsSource = true;',
  '.env': 'SECRET=parent-secret',
  '.env.local': 'SECRET=parent-local',
  'config/.env.production': 'SECRET=parent-prod',
  '.git/config': '[core]',
  'node_modules/left-pad/index.js': 'module.exports = 1;',
  'packages/ui/node_modules/react/index.js': 'module.exports = 2;',
  'dist/bundle.js': 'built();',
  '.next/server/page.js': 'built();',
  'keys/server.pem': '-----BEGIN PRIVATE KEY-----',
  'deploy/tls.key': 'private',
  id_ed25519: 'ssh private',
  '.ssh/id_rsa.pub': 'ssh public',
  '.npmrc': '//registry/:_authToken=parent-token',
  '.yarnrc.yml': 'npmAuthToken: parent-yarn-token',
  '.dev.vars': 'API_KEY=parent-wrangler',
  '.aws/credentials': '[default]',
  '.pgpass': 'db:5432:*:u:p',
  '.docker/config.json': '{"auths":{}}',
  'android/app/release.jks': 'keystore',
  'secrets/credentials.json': '{"client_secret":"x"}',
};
const EXCLUDED = [
  '.env',
  '.env.local',
  'config/.env.production',
  '.git/config',
  'node_modules/left-pad/index.js',
  'packages/ui/node_modules/react/index.js',
  'dist/bundle.js',
  '.next/server/page.js',
  'keys/server.pem',
  'deploy/tls.key',
  'id_ed25519',
  '.ssh/id_rsa.pub',
  '.npmrc',
  '.yarnrc.yml',
  '.dev.vars',
  '.aws/credentials',
  '.pgpass',
  '.docker/config.json',
  'android/app/release.jks',
  'secrets/credentials.json',
];

async function parentBundle(files: Record<string, string> = PARENT_FILES): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

// ---------------------------------------------------------------------------
// A tiny redis: the session store and the rate-limit counters.
// ---------------------------------------------------------------------------

const store = new Map<string, string>();
const counters = new Map<string, number>();
let redisDown = false;

function installRedis() {
  store.clear();
  counters.clear();
  redisDown = false;
  redisMock.sysRedis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.sysRedis.set.mockImplementation(
    async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }
  );
  redisMock.sysRedis.del.mockImplementation(async (key: string) => (store.delete(key) ? 1 : 0));
  redisMock.sysRedis.multi.mockImplementation(() => {
    let key = '';
    const chain = {
      set: (k: string) => {
        key = k;
        return chain;
      },
      incr: () => chain,
      exec: async () => {
        if (redisDown) throw new Error('redis down');
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return ['OK', next];
      },
    };
    return chain;
  });
}

const sessionKey = (slug: string) => `${REDIS_SYS_KEYS.BLOCKS.FORK_SESSION}:${slug}`;

// ---------------------------------------------------------------------------
// The database the start reads.
// ---------------------------------------------------------------------------

let takenSlugs = new Set<string>();
let approvedSha: string | null = APPROVED_SHA;
let listingKind = 'onsite';
let blockStatus = 'approved';

function installDb() {
  takenSlugs = new Set();
  approvedSha = APPROVED_SHA;
  listingKind = 'onsite';
  blockStatus = 'approved';
  dbMock.dbRead.appListing.findFirst.mockImplementation(
    async (args: { where: { id?: string; slug?: string } }) => {
      if (args.where.slug) return takenSlugs.has(args.where.slug) ? { id: 'apl_taken_5199' } : null;
      if (args.where.id === PARENT_LISTING)
        return {
          kind: listingKind,
          appBlock:
            listingKind === 'onsite'
              ? // The block row's own currentVersionSha is a DIFFERENT sha: the fork must use the
                // approved request's, not this.
                {
                  id: PARENT_BLOCK,
                  blockId: PARENT_SLUG,
                  status: blockStatus,
                  currentVersionSha: HEAD_SHA,
                }
              : null,
        };
      return null;
    }
  );
  dbMock.dbRead.appBlock.findFirst.mockImplementation(
    async (args: { where: { blockId?: string } }) =>
      args.where.blockId && takenSlugs.has(args.where.blockId) ? { id: 'ab_taken_5198' } : null
  );
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockImplementation(
    async (args: { where: { status?: string; slug?: string; appBlockId?: string } }) => {
      if (args.where.status === 'approved' && args.where.appBlockId === PARENT_BLOCK)
        return approvedSha ? { forgejoCommitSha: approvedSha } : null;
      return null;
    }
  );
}

let putBodies: Buffer[] = [];
/** Every S3 command sent: its class and key. */
let s3Commands: Array<{ command: string; key: unknown }> = [];
let sendSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.clearAllMocks();
  installRedis();
  installDb();
  m.features = { appBlocks: true, appAssistant: true };
  m.forkFlag = true;
  m.summary.mockResolvedValue({ id: PARENT_LISTING, slug: PARENT_SLUG, name: PARENT_NAME });
  m.forkable.mockResolvedValue({ available: true, forkable: true });
  m.reconstruct.mockImplementation(async () => parentBundle());
  setEnv({
    APP_FORK_SEED_S3_ENDPOINT: `https://${SEED_HOST}`,
    APP_FORK_SEED_S3_BUCKET: 'fork-seed-bucket-test',
    APP_FORK_SEED_S3_ACCESS_KEY_ID: 'AKIAFORKTEST',
    APP_FORK_SEED_S3_SECRET_ACCESS_KEY: 'fork-test-secret',
  });
  putBodies = [];
  s3Commands = [];
  sendSpy = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    const input = (command as { input?: { Body?: unknown } }).input;
    if (input?.Body) putBodies.push(input.Body as Buffer);
    s3Commands.push({
      command: (command as { constructor: { name: string } }).constructor.name,
      key: (input as { Key?: unknown } | undefined)?.Key,
    });
    return {} as never;
  });
});

afterEach(() => {
  sendSpy.mockRestore();
});

const start = (over: Partial<Parameters<typeof startAppFork>[0]> = {}) =>
  startAppFork({
    user: forker,
    listingId: PARENT_LISTING,
    scope: 'full',
    redCapable: false,
    ...over,
  });

// ---------------------------------------------------------------------------

describe('startAppFork — refusals (exact errors)', () => {
  it('a BANNED account is refused with App Assistant’s own message; nothing is read', async () => {
    await expect(
      start({ user: { ...forker, bannedAt: new Date('2026-02-02T00:00:00Z') } as SessionUser })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been banned',
    });
    expect(m.summary).not.toHaveBeenCalled();
  });

  it('a user without App Assistant is refused', async () => {
    m.features = { appBlocks: true, appAssistant: false };
    await expect(start()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'App Assistant is not available on this account',
    });
    expect(m.summary).not.toHaveBeenCalled();
  });

  it('the app-blocks-fork flag OFF is refused', async () => {
    m.forkFlag = false;
    await expect(start()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORK_SETTING_DISABLED_MESSAGE,
    });
    expect(m.summary).not.toHaveBeenCalled();
  });

  it('no seed store in this environment is refused before any read', async () => {
    setEnv({ APP_FORK_SEED_S3_ENDPOINT: undefined });
    await expect(start()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: FORK_UNAVAILABLE_HERE_MESSAGE,
    });
    expect(m.summary).not.toHaveBeenCalled();
  });

  it('🔴 a parent that is not PUBLICLY visible (hidden, removed, restricted) reads as missing', async () => {
    // Everything else about this parent would pass: the visibility check is the only refusal.
    m.summary.mockResolvedValue(null);
    await expect(start({ scope: 'full', redCapable: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: FORK_PARENT_UNAVAILABLE_MESSAGE,
    });
    // Asked at the PUBLIC floor whoever the viewer is, under the viewer's own scope.
    expect(m.summary).toHaveBeenCalledWith(
      { id: PARENT_LISTING },
      { redCapable: true, scope: 'full', floor: 'public' }
    );
    expect(m.reconstruct).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('a parent whose author has not opted in is refused (and so is an unmigrated environment)', async () => {
    m.forkable.mockResolvedValue({ available: true, forkable: false });
    await expect(start()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORK_NOT_ALLOWED_MESSAGE,
    });
    m.forkable.mockResolvedValue({ available: false, forkable: false });
    await expect(start()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORK_NOT_ALLOWED_MESSAGE,
    });
    expect(m.reconstruct).not.toHaveBeenCalled();
  });

  it('an off-site parent (no source here) is refused', async () => {
    listingKind = 'offsite';
    await expect(start()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: FORKABLE_OFFSITE_MESSAGE,
    });
  });

  it('a parent with no approved commit is refused', async () => {
    approvedSha = null;
    await expect(start()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: FORK_NO_APPROVED_VERSION_MESSAGE,
    });
    expect(m.reconstruct).not.toHaveBeenCalled();
  });

  it('a malformed approved sha is refused the same way', async () => {
    approvedSha = 'main';
    await expect(start()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: FORK_NO_APPROVED_VERSION_MESSAGE,
    });
  });

  it('rate limit: 5 an hour — the 6th start is refused', async () => {
    for (let i = 0; i < 5; i++) await expect(start()).resolves.toBeTruthy();
    await expect(start()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: FORK_RATE_LIMITED_MESSAGE,
    });
    expect(m.reconstruct).toHaveBeenCalledTimes(5);
  });

  it('rate limit: 20 a day — refused past it even with the hour window fresh', async () => {
    counters.set(`${REDIS_SYS_KEYS.BLOCKS.FORK_RATE_LIMIT}:${FORKER_ID}:86400`, 20);
    await expect(start()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: FORK_RATE_LIMITED_MESSAGE,
    });
    expect(m.reconstruct).not.toHaveBeenCalled();
  });

  it('rate limit FAILS CLOSED when the counter cannot be read', async () => {
    redisDown = true;
    await expect(start()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: FORK_BUSY_MESSAGE,
    });
    expect(m.reconstruct).not.toHaveBeenCalled();
  });
});

describe('startAppFork — a successful start', () => {
  it('builds the seed from the APPROVED commit, never HEAD', async () => {
    await start();
    expect(m.reconstruct).toHaveBeenCalledTimes(1);
    expect(m.reconstruct).toHaveBeenCalledWith(PARENT_SLUG, APPROVED_SHA);
    expect(m.reconstruct).not.toHaveBeenCalledWith(PARENT_SLUG, HEAD_SHA);
  });

  it('the seed: files at the root, every exclusion absent by name, blockId rewritten', async () => {
    const result = await start();
    expect(putBodies).toHaveLength(1);
    const zip = await JSZip.loadAsync(putBodies[0]);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(names.sort()).toEqual(
      ['README.md', 'block.manifest.json', 'src/build/helper.ts', 'src/index.ts'].sort()
    );
    for (const excluded of EXCLUDED) expect(names).not.toContain(excluded);
    // At the ROOT: no wrapper directory every entry shares.
    expect(names).toContain('block.manifest.json');
    const manifest = JSON.parse(await zip.file('block.manifest.json')!.async('string'));
    expect(manifest).toEqual({
      blockId: result.forkSlug,
      name: PARENT_NAME,
      version: '1.4.0',
      scopes: ['ai:write:budgeted'],
    });
    expect(result.seed.bytes).toBe(putBodies[0].length);
    const { createHash } = await import('crypto');
    expect(result.seed.sha256).toBe(createHash('sha256').update(putBodies[0]).digest('hex'));
  });

  it('the presigned URL: the configured host, https, no port, valid 10 minutes', async () => {
    const { seed, forkSlug } = await start();
    const url = new URL(seed.url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe(SEED_HOST);
    expect(url.port).toBe('');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.pathname).toBe(`/fork-seed-bucket-test/fork-seeds/${forkSlug}/${seed.sha256}.zip`);
  });

  it('records the fork session — the only source of the fork’s provenance', async () => {
    const result = await start();
    expect(result).toMatchObject({
      parentName: PARENT_NAME,
      parentListingId: PARENT_LISTING,
    });
    const recorded = JSON.parse(store.get(sessionKey(result.forkSlug))!);
    expect(recorded).toMatchObject({
      forkSlug: result.forkSlug,
      userId: FORKER_ID,
      parentAppBlockId: PARENT_BLOCK,
      parentCommitSha: APPROVED_SHA,
      parentListingId: PARENT_LISTING,
      parentName: PARENT_NAME,
      seed: result.seed,
    });
    const lastSet = redisMock.sysRedis.set.mock.calls.at(-1)!;
    expect(lastSet[0]).toBe(sessionKey(result.forkSlug));
    expect(lastSet[2]).toEqual({ EX: FORK_SESSION_TTL_SECONDS });
  });

  it('a valid, unique slug: skips one the database holds and one another session reserved', async () => {
    const seen: string[] = [];
    let calls = 0;
    dbMock.dbRead.appBlock.findFirst.mockImplementation(
      async (args: { where: { blockId: string } }) => {
        seen.push(args.where.blockId);
        // The first candidate is an existing app.
        return calls++ === 0 ? { id: 'ab_taken_5197' } : null;
      }
    );
    // The second candidate is free in the database but already reserved by another fork.
    redisMock.sysRedis.set.mockImplementationOnce(async () => null);
    const { forkSlug } = await start();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(forkSlug).toBe(seen[2]);
    expect(forkSlug).not.toBe(seen[0]);
    expect(forkSlug).not.toBe(seen[1]);
    expect(forkSlug).toMatch(/^pixel-garden-fork-[0-9a-f]{4}$/);
    expect(isValidForkSlug(forkSlug)).toBe(true);
  });

  it('🔴 writes nothing to the database: no approvals, scopes, goods or entitlements are copied', async () => {
    await start();
    expect(calledHybridNodes(['dbWrite'])).toEqual([]);
  });

  it('a failed build releases the slug reservation', async () => {
    m.reconstruct.mockRejectedValue(new Error('forgejo unavailable'));
    await expect(start()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: FORK_SOURCE_UNREADABLE_MESSAGE,
    });
    expect(
      [...store.keys()].filter((k) => k.startsWith(REDIS_SYS_KEYS.BLOCKS.FORK_SESSION))
    ).toEqual([]);
  });

  it('a parent bundle with no manifest is refused, and the reservation released', async () => {
    m.reconstruct.mockImplementation(async () => parentBundle({ 'README.md': '# no manifest' }));
    await expect(start()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: FORK_SOURCE_UNREADABLE_MESSAGE,
    });
    expect(store.size).toBe(0);
  });
});

describe('startAppFork — round-1 audit cases', () => {
  it('a parent whose APP is suspended behind a still-approved listing reads as missing', async () => {
    blockStatus = 'suspended';
    await expect(start()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: FORK_PARENT_UNAVAILABLE_MESSAGE,
    });
    expect(m.reconstruct).not.toHaveBeenCalled();
  });

  it.each([['http://seeds.fork-store.test'], ['https://seeds.fork-store.test:8443']])(
    'an endpoint the sandbox service would refuse (%s) refuses every fork up front: no upload',
    async (endpoint) => {
      setEnv({ APP_FORK_SEED_S3_ENDPOINT: endpoint });
      await expect(start()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: FORK_UNAVAILABLE_HERE_MESSAGE,
      });
      expect(s3Commands).toEqual([]);
      expect(m.summary).not.toHaveBeenCalled();
    }
  );

  it('a start that fails AFTER uploading deletes the seed it uploaded', async () => {
    // The final session write (no NX) fails; the reservation (NX) succeeded.
    redisMock.sysRedis.set.mockImplementation(
      async (key: string, value: string, opts?: { NX?: boolean }) => {
        if (!opts?.NX) throw new Error('redis write failed');
        store.set(key, value);
        return 'OK';
      }
    );
    await expect(start()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: FORK_SOURCE_UNREADABLE_MESSAGE,
    });
    const put = s3Commands.find((c) => c.command === 'PutObjectCommand');
    expect(put?.key).toMatch(/^fork-seeds\/pixel-garden-fork-[0-9a-f]{4}\/[0-9a-f]{64}\.zip$/);
    expect(s3Commands.filter((c) => c.command === 'DeleteObjectCommand')).toEqual([
      { command: 'DeleteObjectCommand', key: put?.key },
    ]);
    expect(store.size).toBe(0);
  });
});

describe('fork slugs', () => {
  it('collapse hyphen runs, cut long parents to fit 40, and stay valid', () => {
    expect(forkSlugFor('a--b', '0f0f')).toBe('a-b-fork-0f0f');
    const long = forkSlugFor('a'.repeat(40), '1a2b');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe(`${'a'.repeat(30)}-fork-1a2b`);
    expect(isValidForkSlug(long)).toBe(true);
    // Not 'a--b…': that would also fail as a reserved id, hiding a broken `--` rule.
    expect(isValidForkSlug('ab--c-fork-0f0f')).toBe(false);
    expect(isValidForkSlug('9app-fork-0f0f')).toBe(false);
  });

  it('never accepts a reserved app id (a fork of an app named "dev" would be a dev tunnel host)', () => {
    expect(forkSlugFor('dev', '0f0f')).toBe('dev-fork-0f0f');
    expect(isValidForkSlug('dev-fork-0f0f')).toBe(false);
    expect(isValidForkSlug('review-fork-0f0f')).toBe(false);
    expect(isValidForkSlug('devtools-fork-0f0f')).toBe(true);
  });

  it('exclusions are by path segment, not substring', () => {
    expect(forkSeedExclusionReason('src/environment.ts')).toBeNull();
    expect(forkSeedExclusionReason('docs/build/guide.md')).toBeNull();
    expect(forkSeedExclusionReason('src/.envrc')).toBe('env');
    expect(forkSeedExclusionReason('build/out.js')).toBe('build-output');
  });
});

describe('getForkSessionForUser — the owner only', () => {
  it('the owner reads it; anyone else reads null; an expired seed reads null', async () => {
    const { forkSlug, seed } = await start();
    await expect(getForkSessionForUser({ userId: FORKER_ID, forkSlug })).resolves.toEqual({
      forkSlug,
      parentName: PARENT_NAME,
      parentListingId: PARENT_LISTING,
      seed,
    });
    await expect(getForkSessionForUser({ userId: OTHER_USER_ID, forkSlug })).resolves.toBeNull();
    await expect(
      getForkSessionForUser({
        userId: FORKER_ID,
        forkSlug,
        now: new Date(Date.now() + 11 * 60 * 1000),
      })
    ).resolves.toMatchObject({ forkSlug, seed: null });
  });
});

describe('applyForkSessionToFirstPublishRequest — provenance only from the session', () => {
  it('the submitter’s own session records its parent on the request', async () => {
    const { forkSlug } = await start();
    await expect(
      applyForkSessionToFirstPublishRequest({
        publishRequestId: 'pubreq_fork_5301',
        slug: forkSlug,
        submittedByUserId: FORKER_ID,
      })
    ).resolves.toBe(true);
    expect(m.setProvenance).toHaveBeenCalledWith(expect.anything(), {
      publishRequestId: 'pubreq_fork_5301',
      forkOfAppBlockId: PARENT_BLOCK,
      forkOfCommitSha: APPROVED_SHA,
    });
  });

  it('another user submitting the slug gets nothing', async () => {
    const { forkSlug } = await start();
    await expect(
      applyForkSessionToFirstPublishRequest({
        publishRequestId: 'pubreq_other_5302',
        slug: forkSlug,
        submittedByUserId: OTHER_USER_ID,
      })
    ).resolves.toBe(false);
    expect(m.setProvenance).not.toHaveBeenCalled();
  });

  it('a slug with no session gets nothing, and a failure never throws', async () => {
    await expect(
      applyForkSessionToFirstPublishRequest({
        publishRequestId: 'pubreq_none_5303',
        slug: 'unforked-app',
        submittedByUserId: FORKER_ID,
      })
    ).resolves.toBe(false);
    redisMock.sysRedis.get.mockRejectedValue(new Error('redis down'));
    await expect(
      applyForkSessionToFirstPublishRequest({
        publishRequestId: 'pubreq_err_5304',
        slug: 'unforked-app',
        submittedByUserId: FORKER_ID,
      })
    ).resolves.toBe(false);
    expect(m.setProvenance).not.toHaveBeenCalled();
  });
});

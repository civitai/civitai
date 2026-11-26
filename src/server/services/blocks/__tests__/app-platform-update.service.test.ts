import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as FliptClient from '~/server/flipt/client';

/**
 * Staff platform updates end to end: the real services and router, against
 *   - the real `app_platform_updates` + `app_source_repos` migrations in PGlite (every raw query);
 *   - a FAKE git host at the HTTP boundary (global `fetch`), with the contents API's
 *     compare-and-set (a stale blob sha or an existing path refuses the commit);
 *   - fixtures for the Prisma model reads (blocks, users, seats, approved versions);
 *   - the notifications client stub (setup.ts), observed rather than replaced.
 *
 * Claims (each `it` names one):
 *   - a non-moderator is refused, by the router AND by the service's database re-check;
 *   - a reason is required;
 *   - a push writes one commit on its own branch (main untouched), the Platform-Update trailers,
 *     the record, and the owner's notification;
 *   - an app with no source repo gets one seeded from its latest approved version first, and the
 *     build repo is only read;
 *   - the owner list returns only this app's PENDING updates, to the owner or an accepted
 *     collaborator only;
 *   - "verified staff" comes from the record and the author's moderator status, never from a
 *     commit's text.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const flags = vi.hoisted(() => ({ platformUpdates: true }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: async (flag: string) =>
      flag === actual.FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES
        ? flags.platformUpdates
        : false,
  };
});

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);
const SRC = 'civitai-apps-src';
const BUILD = 'civitai-apps';
const HOST = 'https://git.fake.test';

// ---------------------------------------------------------------------------
// The fake git host
// ---------------------------------------------------------------------------

const { createHash } = await import('crypto');
const blob = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
let commitSeq = 0;
const nextSha = () => (++commitSeq).toString(16).padStart(40, '0');

type Branch = { head: string; files: Record<string, string> };

class FakeGit {
  orgs = new Set<string>();
  repos = new Map<string, Map<string, Branch>>();
  commits: Array<{ sha: string; branch: string; message: string; author: unknown }> = [];
  writes: Array<{ method: string; path: string }> = [];
  calls: Array<{ method: string; path: string }> = [];

  branch(org: string, slug: string, name = 'main') {
    return this.repos.get(`${org}/${slug}`)?.get(name) ?? null;
  }

  addRepo(org: string, slug: string, files: Record<string, string>, head = nextSha()) {
    this.orgs.add(org);
    this.repos.set(`${org}/${slug}`, new Map([['main', { head, files: { ...files } }]]));
  }

  /** A developer's `git push`: a commit with any message, straight onto the branch. */
  devPush(org: string, slug: string, change: Record<string, string>, message: string) {
    const b = this.branch(org, slug)!;
    b.files = { ...b.files, ...change };
    b.head = nextSha();
    this.commits.push({ sha: b.head, branch: 'main', message, author: { name: 'Civitai' } });
    return b.head;
  }

  async handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const p = url.pathname;
    this.calls.push({ method, path: p });
    if (method !== 'GET') this.writes.push({ method, path: p });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const json = (status: number, data?: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status });
    let m: RegExpMatchArray | null;

    if ((m = p.match(/^\/api\/v1\/orgs\/([^/]+)$/)) && method === 'GET')
      return this.orgs.has(decodeURIComponent(m[1])) ? json(200, {}) : json(404, {});
    if (method === 'POST' && p === '/api/v1/orgs') {
      if (this.orgs.has(body.username)) return json(422, {});
      this.orgs.add(body.username);
      return json(201, {});
    }
    if ((m = p.match(/^\/api\/v1\/orgs\/([^/]+)\/repos$/)) && method === 'POST') {
      const key = `${m[1]}/${body.name}`;
      if (this.repos.has(key)) return json(409, {});
      this.repos.set(
        key,
        new Map([['main', { head: nextSha(), files: { 'README.md': `# ${body.name}\n` } }]])
      );
      return json(201, { name: body.name });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/))) {
      const b = this.branch(m[1], m[2], decodeURIComponent(m[3]));
      return b ? json(200, { commit: { id: b.head } }) : json(404, {});
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/))) {
      const ref = decodeURIComponent(m[3]);
      const b = [...(this.repos.get(`${m[1]}/${m[2]}`)?.values() ?? [])].find(
        (x) => x.head === ref
      );
      if (!b) return json(404, {});
      const page = Number(url.searchParams.get('page') ?? '1');
      const tree =
        page === 1
          ? Object.entries(b.files).map(([fp, c]) => ({ path: fp, type: 'blob', sha: blob(c) }))
          : [];
      return json(200, { tree, total_count: Object.keys(b.files).length });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/))) {
      for (const branches of this.repos.values())
        for (const b of branches.values())
          for (const c of Object.values(b.files))
            if (blob(c) === m[3])
              return json(200, { content: Buffer.from(c).toString('base64'), encoding: 'base64' });
      return json(404, {});
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/contents$/)) && method === 'POST') {
      const [org, slug] = [m[1], m[2]];
      const base = this.branch(org, slug, body.branch);
      if (!base) return json(404, {});
      const files = { ...base.files };
      for (const op of body.files as Array<{
        operation: string;
        path: string;
        content?: string;
        sha?: string;
      }>) {
        const exists = op.path in files;
        if (op.operation === 'create') {
          if (exists) return json(422, {});
          files[op.path] = Buffer.from(op.content!, 'base64').toString('utf8');
        } else {
          if (!exists) return json(404, {});
          if (blob(files[op.path]) !== op.sha) return json(422, {});
          if (op.operation === 'delete') delete files[op.path];
          else files[op.path] = Buffer.from(op.content!, 'base64').toString('utf8');
        }
      }
      const target = body.new_branch ?? body.branch;
      if (body.new_branch && this.branch(org, slug, body.new_branch)) return json(422, {});
      const sha = nextSha();
      this.repos.get(`${org}/${slug}`)!.set(target, { head: sha, files });
      this.commits.push({ sha, branch: target, message: body.message, author: body.author });
      return json(201, { commit: { sha } });
    }
    return json(500, { message: `fake git host: unhandled ${method} ${p}` });
  }
}

let git: FakeGit;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOD = 8001;
const EX_MOD = 8003;
const NOT_MOD = 8002;
const OWNER = 7101;
const OTHER = 7102;
const EDITOR = 7103;
const SLUG = 'pixel-garden';
const OTHER_SLUG = 'moon-garden';
const APPROVED = 'ab'.repeat(20);
const REASON = 'Bump @civitai/app-sdk to 2.4.0: the old floor stops working on Dec 1.';

const users: Record<number, { username: string; isModerator: boolean }> = {
  [MOD]: { username: 'mod-ana', isModerator: true },
  [EX_MOD]: { username: 'ex-mod-bo', isModerator: true },
  [NOT_MOD]: { username: 'plain-dev', isModerator: false },
  [OWNER]: { username: 'owner-olga', isModerator: false },
  [OTHER]: { username: 'other-otto', isModerator: false },
  [EDITOR]: { username: 'editor-eve', isModerator: false },
};
const blocks = [
  { id: 'ab_app', blockId: SLUG, status: 'approved', ownerUserId: OWNER },
  { id: 'ab_other', blockId: OTHER_SLUG, status: 'approved', ownerUserId: OTHER },
];
const listings = [{ id: 'apl_app', appBlockId: 'ab_app' }];
const seats = [{ appListingId: 'apl_app', userId: EDITOR }];
let approved: Record<string, { forgejoCommitSha: string; version: string }>;

function installModelReads() {
  const shape = (b: (typeof blocks)[number]) => ({
    id: b.id,
    blockId: b.blockId,
    status: b.status,
    app: { userId: b.ownerUserId },
  });
  dbMock.dbRead.appBlock.findUnique.mockImplementation(async (a: { where: { id: string } }) => {
    const b = blocks.find((x) => x.id === a.where.id);
    return b ? shape(b) : null;
  });
  dbMock.dbRead.appBlock.findFirst.mockImplementation(async (a: { where: { blockId: string } }) => {
    const b = blocks.find((x) => x.blockId === a.where.blockId);
    return b ? shape(b) : null;
  });
  dbMock.dbRead.user.findUnique.mockImplementation(async (a: { where: { id: number } }) =>
    users[a.where.id] ? { ...users[a.where.id] } : null
  );
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockImplementation(
    async (a: { where: { appBlockId?: string; status?: string } }) =>
      a.where.status === 'approved' && a.where.appBlockId && approved[a.where.appBlockId]
        ? { ...approved[a.where.appBlockId] }
        : null
  );
  dbMock.dbRead.appListing.findUnique.mockImplementation(
    async (a: { where: { appBlockId: string } }) =>
      listings.find((l) => l.appBlockId === a.where.appBlockId) ?? null
  );
  dbMock.dbRead.appCollaborator.findFirst.mockImplementation(
    async (a: { where: { appListingId: string; userId: number; status: string } }) =>
      a.where.status === 'accepted' &&
      seats.some((s) => s.appListingId === a.where.appListingId && s.userId === a.where.userId)
        ? { userId: a.where.userId }
        : null
  );
}

let pg: PGlite;
function installRaw() {
  const raw = pgliteRaw(pg);
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.$queryRaw.mockImplementation(raw.queryRaw);
    client.$executeRaw.mockImplementation(raw.executeRaw);
  }
}

const redisStore = new Map<string, string>();
function installRedis() {
  redisStore.clear();
  redisMock.redis.set.mockImplementation(async (k: string, v: string, o?: { NX?: boolean }) => {
    if (o?.NX && redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  });
  redisMock.redis.eval.mockImplementation(
    async (_s: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
      if (redisStore.get(keys[0]) !== args[0]) return 0;
      redisStore.delete(keys[0]);
      return 1;
    }
  );
}

const { notifications } = await import('~/server/notifications/client');
const createNotification = vi.mocked(
  (notifications as unknown as { createNotification: (d: unknown) => Promise<void> })
    .createNotification
);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" (id INT PRIMARY KEY, username TEXT, "isModerator" BOOLEAN NOT NULL);
    CREATE TABLE app_blocks (
      id TEXT PRIMARY KEY, block_id TEXT, fork_of_app_block_id TEXT, fork_of_commit_sha TEXT
    );
  `);
  for (const [id, u] of Object.entries(users))
    await pg.query(`INSERT INTO "User" VALUES ($1, $2, $3)`, [
      Number(id),
      u.username,
      u.isModerator,
    ]);
  for (const b of blocks)
    await pg.query(`INSERT INTO app_blocks (id, block_id) VALUES ($1, $2)`, [b.id, b.blockId]);
  for (const dir of ['20270105120000_app_source_repos', '20271205140000_app_platform_updates'])
    await pg.exec(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
});
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`TRUNCATE app_platform_updates, app_source_repos;
    UPDATE "User" SET "isModerator" = (id IN (${MOD}, ${EX_MOD}));`);
  flags.platformUpdates = true;
  commitSeq = 0;
  git = new FakeGit();
  approved = {};
  installModelReads();
  installRaw();
  installRedis();
  createNotification.mockReset();
  createNotification.mockResolvedValue(undefined);
  setEnv({
    FORGEJO_BASE_URL: HOST,
    FORGEJO_PUBLIC_URL: HOST,
    FORGEJO_ADMIN_TOKEN: 'admin-token-test',
    FORGEJO_API_TIMEOUT_MS: 15000,
    FORGEJO_COMMIT_TIMEOUT_MS: 60000,
  });
  vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) =>
    git.handle(new URL(String(input)), init)
  );
});

/** An existing source repo for `pixel-garden`, bound to its block. */
async function existingSourceRepo(files: Record<string, string>) {
  git.addRepo(SRC, SLUG, files);
  await pg.query(
    `INSERT INTO app_source_repos (slug, owner_user_id, app_block_id, origin) VALUES ($1, $2, $3, 'fork')`,
    [SLUG, OWNER, 'ab_app']
  );
}

const svc = await import('~/server/services/blocks/app-platform-update.service');
const { appPlatformUpdatesRouter } = await import('~/server/routers/app-platform-updates.router');

const put = (p: string, content: string) =>
  ({ operation: 'put', path: p, content: Buffer.from(content) } as const);
const PKG_OLD = '{"dependencies":{"@civitai/app-sdk":"2.1.0"}}';
const PKG_NEW = '{"dependencies":{"@civitai/app-sdk":"2.4.0"}}';

const pushAsMod = (staffUserId = MOD, reason = REASON) =>
  svc.pushPlatformUpdate({
    staffUserId,
    app: { slug: SLUG },
    reason,
    changes: [put('package.json', PKG_NEW), put('src/sdk-shim.ts', 'export {};\n')],
  });

const session = (id: number) =>
  ({
    user: {
      id,
      isModerator: users[id].isModerator,
      onboarding: OnboardingSteps.Buzz,
      muted: false,
    },
    acceptableOrigin: true,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    features: { appBlocks: true },
    req: { headers: {} },
    res: { setHeader: () => undefined },
  } as never);
const caller = (id: number) => appPlatformUpdatesRouter.createCaller(session(id));

const updateRows = async () =>
  (await pg.query(`SELECT * FROM app_platform_updates ORDER BY created_at, id`)).rows as Array<
    Record<string, unknown>
  >;

// ---------------------------------------------------------------------------

describe('who may push', () => {
  it('a non-moderator session is refused by the router before anything is read or written', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    await expect(
      caller(NOT_MOD).push({
        slug: SLUG,
        reason: REASON,
        changes: [{ operation: 'put', path: 'package.json', content: PKG_NEW, encoding: 'utf8' }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(git.writes).toEqual([]);
    expect(await updateRows()).toEqual([]);
  });

  it('the service re-checks moderator status in the database, not the session', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    await expect(pushAsMod(NOT_MOD)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only Civitai staff can push updates',
    });
    expect(git.writes).toEqual([]);
    expect(await updateRows()).toEqual([]);
  });

  it('the flag off: push refuses and the owner list answers empty', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    flags.platformUpdates = false;
    await expect(
      caller(MOD).push({
        slug: SLUG,
        reason: REASON,
        changes: [{ operation: 'put', path: 'package.json', content: PKG_NEW, encoding: 'utf8' }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Platform updates are not enabled' });
    expect(await caller(OWNER).listPending({ slug: SLUG })).toEqual({ updates: [] });
    expect(git.writes).toEqual([]);
  });
});

describe('push', () => {
  it('a reason is required: a blank one is refused before the git host is called', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    await expect(pushAsMod(MOD, ' \n\t ')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A reason is required',
    });
    expect(git.calls).toEqual([]);
    expect(await updateRows()).toEqual([]);
  });

  it('commits to its own branch with the trailers, records it, and tells the owner', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD, 'block.manifest.json': '{}' });
    const mainBefore = { ...git.branch(SRC, SLUG)! };
    const result = await caller(MOD).push({
      slug: SLUG,
      reason: REASON,
      changes: [
        { operation: 'put', path: 'package.json', content: PKG_NEW, encoding: 'utf8' },
        {
          operation: 'put',
          path: 'src/sdk-shim.ts',
          content: Buffer.from('export {};\n').toString('base64'),
          encoding: 'base64',
        },
      ],
    });
    expect(result.id).toMatch(/^apu_[0-9A-Z]{26}$/);
    const branch = `platform-update/${result.id.toLowerCase()}`;
    expect(result).toEqual({
      id: result.id,
      slug: SLUG,
      branch,
      commitSha: '0000000000000000000000000000000000000002',
      baseCommitSha: '0000000000000000000000000000000000000001',
      seededSourceRepo: false,
      paths: [
        { path: 'src/sdk-shim.ts', operation: 'create' },
        { path: 'package.json', operation: 'update' },
      ],
    });
    // main is untouched; the branch holds main plus the change.
    expect(git.branch(SRC, SLUG)).toEqual(mainBefore);
    expect(git.branch(SRC, SLUG, branch)!.files).toEqual({
      'package.json': PKG_NEW,
      'block.manifest.json': '{}',
      'src/sdk-shim.ts': 'export {};\n',
    });
    expect(git.commits).toEqual([
      {
        sha: '0000000000000000000000000000000000000002',
        branch,
        author: { name: 'Civitai', email: 'platform@apps.civitai.invalid' },
        message:
          'Platform update: add src/sdk-shim.ts, update package.json\n\n' +
          'Bump @civitai/app-sdk to 2.4.0: the old floor stops working on Dec 1.\n\n' +
          `Platform-Update: ${result.id}\n` +
          'Platform-Update-By: mod-ana\n' +
          'Reason: Bump @civitai/app-sdk to 2.4.0: the old floor stops working on Dec 1.',
      },
    ]);
    // Never the build repo.
    expect(git.writes.filter((w) => w.path.includes(`/${BUILD}/`))).toEqual([]);

    const rows = await updateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.id,
      app_block_id: 'ab_app',
      slug: SLUG,
      staff_user_id: MOD,
      reason: REASON,
      branch,
      base_commit_sha: '0000000000000000000000000000000000000001',
      commit_sha: '0000000000000000000000000000000000000002',
      paths: [
        { path: 'src/sdk-shim.ts', operation: 'create' },
        { path: 'package.json', operation: 'update' },
      ],
      seeded_source_repo: false,
      status: 'pending',
      merge_commit_sha: null,
      resolved_by_user_id: null,
    });

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      userId: OWNER,
      type: 'app-platform-update',
      key: `app-platform-update:${result.id}`,
      details: { slug: SLUG, updateId: result.id, byUsername: 'mod-ana', reason: REASON },
    });
  });

  it('a source repo under the slug that is not this app’s is never written', async () => {
    git.addRepo(SRC, SLUG, { 'package.json': PKG_OLD });
    // Bound to the OTHER app's block: someone else's repo under this slug.
    await pg.query(
      `INSERT INTO app_source_repos (slug, owner_user_id, app_block_id, origin) VALUES ($1, $2, 'ab_other', 'fork')`,
      [SLUG, OTHER]
    );
    await expect(pushAsMod()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The source repo under this slug belongs to a different app',
    });
    expect(git.writes).toEqual([]);
    expect(await updateRows()).toEqual([]);
  });
});

describe('an app with no source repo', () => {
  it('is seeded from its latest approved version, then the update goes on top', async () => {
    git.addRepo(
      BUILD,
      SLUG,
      {
        'block.manifest.json': '{"blockId":"pixel-garden"}',
        'package.json': PKG_OLD,
        '.env': 'K=1',
      },
      APPROVED
    );
    approved.ab_app = { forgejoCommitSha: APPROVED, version: '1.2.0' };

    const result = await pushAsMod();
    expect(result.seededSourceRepo).toBe(true);

    // The seed: exactly the approved files, minus what a source repo never holds (.env).
    const main = git.branch(SRC, SLUG)!;
    expect(main.files).toEqual({
      'block.manifest.json': '{"blockId":"pixel-garden"}',
      'package.json': PKG_OLD,
    });
    expect(git.commits.map((c) => [c.branch, c.message])).toEqual([
      ['main', `Import v1.2.0\n\nApproved-Commit: ${APPROVED}`],
      [
        result.branch,
        expect.stringMatching(/^Platform update: add src\/sdk-shim.ts, update package.json\n/),
      ],
    ]);
    expect(result.baseCommitSha).toBe(main.head);
    expect(git.branch(SRC, SLUG, result.branch)!.files).toEqual({
      'block.manifest.json': '{"blockId":"pixel-garden"}',
      'package.json': PKG_NEW,
      'src/sdk-shim.ts': 'export {};\n',
    });
    // The build repo is read, never written.
    expect(git.writes.filter((w) => w.path.includes(`/${BUILD}/`))).toEqual([]);

    const repo = (
      await pg.query(`SELECT slug, owner_user_id, app_block_id, origin FROM app_source_repos`)
    ).rows;
    expect(repo).toEqual([
      { slug: SLUG, owner_user_id: OWNER, app_block_id: 'ab_app', origin: 'backfill' },
    ]);
    expect((await updateRows())[0]).toMatchObject({ seeded_source_repo: true, status: 'pending' });
  });

  it('with no approved version either, nothing is created', async () => {
    await expect(pushAsMod()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'The app has no source repo and no approved version to create one from',
    });
    expect(git.writes).toEqual([]);
    expect((await pg.query(`SELECT * FROM app_source_repos`)).rows).toEqual([]);
  });
});

describe('the owner API', () => {
  it('lists only this app’s PENDING updates, to the owner and an accepted collaborator only', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const first = await pushAsMod();
    const second = await svc.pushPlatformUpdate({
      staffUserId: MOD,
      app: { slug: SLUG },
      reason: 'Add the missing privacy link.',
      changes: [put('PRIVACY.md', 'See civitai.com/content/privacy\n')],
    });
    // Noise the list must leave out: a merged update of this app, and another app's pending one.
    const merged = await svc.pushPlatformUpdate({
      staffUserId: MOD,
      app: { slug: SLUG },
      reason: 'Already merged.',
      changes: [put('MERGED.md', 'm\n')],
    });
    await pg.query(`UPDATE app_platform_updates SET status = 'merged' WHERE id = $1`, [merged.id]);
    await pg.query(
      `INSERT INTO app_platform_updates (id, app_block_id, slug, staff_user_id, reason, branch,
         base_commit_sha, commit_sha, paths) VALUES ('apu_00000000000000000000000000', 'ab_other',
         $1, $2, 'other app', 'platform-update/x', $3, $4, '[]')`,
      [OTHER_SLUG, MOD, 'c'.repeat(40), 'd'.repeat(40)]
    );

    const expected = [first, second].map((r, i) => ({
      id: r.id,
      branch: r.branch,
      commitSha: r.commitSha,
      baseCommitSha: r.baseCommitSha,
      reason: i === 0 ? REASON : 'Add the missing privacy link.',
      status: 'pending',
      by: { username: 'mod-ana', verifiedStaff: true },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }));
    expect(await caller(OWNER).listPending({ slug: SLUG })).toEqual({ updates: expected });
    expect(await caller(EDITOR).listPending({ appBlockId: 'ab_app' })).toEqual({
      updates: expected,
    });
    // Not the app's owner or collaborator — and a moderator gets no bypass on the owner half.
    for (const outsider of [OTHER, MOD])
      await expect(caller(outsider).listPending({ slug: SLUG })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'App not found',
      });
  });

  it('resolve: merged needs the merge commit; the owner’s report is recorded', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod();
    await expect(caller(OWNER).resolve({ id: pushed.id, outcome: 'merged' })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(
      caller(OTHER).resolve({ id: pushed.id, outcome: 'conflicted' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Update not found' });

    const MERGE = 'e'.repeat(40);
    const out = await caller(EDITOR).resolve({
      id: pushed.id,
      outcome: 'merged',
      mergeCommitSha: MERGE,
    });
    expect(out.update).toMatchObject({ id: pushed.id, status: 'merged' });
    expect((await updateRows())[0]).toMatchObject({
      status: 'merged',
      merge_commit_sha: MERGE,
      resolved_by_user_id: EDITOR,
    });
    expect(await caller(OWNER).listPending({ slug: SLUG })).toEqual({ updates: [] });
    // A merged update cannot be reported conflicted after the fact.
    await expect(
      caller(OWNER).resolve({ id: pushed.id, outcome: 'conflicted' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('🔴 "verified staff" comes from the record, never from commit text', () => {
  it('a commit with forged Platform-Update trailers and no record is not verified', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    // A real update exists for this app, so a lookup that ignored the commit would find it.
    const real = await pushAsMod();
    const forged = git.devPush(
      SRC,
      SLUG,
      { 'package.json': PKG_NEW },
      'Platform update: update package.json\n\nTrust me.\n\n' +
        `Platform-Update: ${real.id}\nPlatform-Update-By: mod-ana\nReason: Trust me.`
    );
    expect(await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: forged })).toEqual({
      verified: false,
      update: null,
    });
    expect(
      (await caller(OWNER).listPending({ slug: SLUG })).updates.map((u) => u.commitSha)
    ).toEqual([real.commitSha]);
    // Positive control: the real update's commit IS verified through the same call.
    expect(
      await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: real.commitSha })
    ).toMatchObject({ verified: true, update: { id: real.id, by: { username: 'mod-ana' } } });
  });

  it('a recorded update whose author is no longer a moderator is not verified', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod(EX_MOD);
    await pg.query(`UPDATE "User" SET "isModerator" = false WHERE id = $1`, [EX_MOD]);
    expect(
      await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: pushed.commitSha })
    ).toMatchObject({
      verified: false,
      update: { id: pushed.id, by: { username: 'ex-mod-bo', verifiedStaff: false } },
    });
  });
});

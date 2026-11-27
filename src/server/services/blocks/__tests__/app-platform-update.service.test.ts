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
import type { SubmitVersionParams } from '~/server/services/blocks/publish-request.service';

/**
 * Staff platform updates end to end: the real services and router, against
 *   - the real `app_platform_updates` + `app_source_repos` migrations in PGlite (every raw query);
 *   - a FAKE git host at the HTTP boundary (global `fetch`), modelled as a commit graph (parents,
 *     forks that share history, a 3-way `merge` for an owner's checkout), with the contents API's
 *     compare-and-set (a stale blob sha or an existing path refuses the commit);
 *   - fixtures for the Prisma model reads (blocks, users, seats, approved versions);
 *   - the notifications client stub (setup.ts), observed rather than replaced.
 *
 * Claims (each `it` names one):
 *   - a non-moderator is refused, by the router AND by the service's database re-check;
 *   - a reason is required;
 *   - a push writes one commit on its own branch (main untouched), the Platform-Update trailers,
 *     the record, and the owner's notification;
 *   - an app with no source repo gets one as a FORK of its build repo first (the build repo is
 *     only read), so an owner's existing checkout of the build repo merges the update cleanly;
 *     every update to such a fork (a retry after a failed first push and every later one too) is
 *     cut from the latest approved commit, never a newer unapproved push; a newer approval is
 *     synced into the fork, or the push is refused; any other source repo is cut from its main;
 *   - the record names the commit's real parent, and whether the update touches the manifest;
 *   - the owner list returns this app's OPEN updates (pending AND conflicted, oldest first, each
 *     with its status; never merged or superseded), to the owner or an accepted collaborator only;
 *   - "verified staff" comes from the record and the author's standing now (moderator, not
 *     banned), never from a commit's text; a superseded update is not verified;
 *   - supersede, modList, conflicted → merged, and the flag off for every owner procedure.
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

type Files = Record<string, string>;
type Commit = { parents: string[]; files: Files };
type Branch = { head: string; files: Files };

/** The outcome of `git merge <theirs>` into a checkout at `ours`, modelled on git's 3-way merge. */
type MergeOutcome =
  | { kind: 'unrelated' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'clean'; files: Files };

/**
 * The git host, modelled as a commit graph: every commit has parents and a full tree, a branch is
 * a name for a commit, and a fork copies the parent repo's refs (so the two share history).
 */
class FakeGit {
  orgs = new Set<string>();
  objects = new Map<string, Commit>();
  refs = new Map<string, Map<string, string>>();
  forkOf = new Map<string, string>();
  commits: Array<{ sha: string; branch: string; message: string; author: unknown }> = [];
  writes: Array<{ method: string; path: string }> = [];
  calls: Array<{ method: string; path: string }> = [];
  /** Runs inside a contents-API write, after the request arrived and before it applies. */
  beforeCommit: (() => void) | null = null;

  private commit(parents: string[], files: Files, sha = nextSha()) {
    this.objects.set(sha, { parents, files: { ...files } });
    return sha;
  }

  branch(org: string, slug: string, name = 'main'): Branch | null {
    const head = this.refs.get(`${org}/${slug}`)?.get(name);
    return head ? { head, files: { ...this.objects.get(head)!.files } } : null;
  }

  parents(sha: string) {
    return this.objects.get(sha)?.parents ?? null;
  }

  addRepo(org: string, slug: string, files: Files, head = nextSha()) {
    this.orgs.add(org);
    this.commit([], files, head);
    this.refs.set(`${org}/${slug}`, new Map([['main', head]]));
  }

  /** A `git push` of one commit with any message onto `branch`, by anyone with push access. */
  devPush(org: string, slug: string, change: Files, message: string, branch = 'main') {
    const before = this.branch(org, slug, branch)!;
    const sha = this.commit([before.head], { ...before.files, ...change });
    this.refs.get(`${org}/${slug}`)!.set(branch, sha);
    this.commits.push({ sha, branch, message, author: { name: 'Civitai' } });
    return sha;
  }

  /** A commit that exists only in someone's local checkout (never pushed). */
  localCommit(parent: string, change: Files) {
    return this.commit([parent], { ...this.objects.get(parent)!.files, ...change });
  }

  private ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...(this.objects.get(c)?.parents ?? []));
    }
    return seen;
  }

  private reachable(repo: string, sha: string) {
    return [...(this.refs.get(repo)?.values() ?? [])].some((h) => this.ancestors(h).has(sha));
  }

  /** `git merge <theirs>` in a checkout whose HEAD is `ours`. */
  merge(ours: string, theirs: string): MergeOutcome {
    const theirAncestors = this.ancestors(theirs);
    // The nearest common ancestor, walking back from `ours` (the histories here are linear).
    const queue = [ours];
    let base: string | null = null;
    for (const seen = new Set<string>(); queue.length; ) {
      const c = queue.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      if (theirAncestors.has(c)) {
        base = c;
        break;
      }
      queue.push(...(this.objects.get(c)?.parents ?? []));
    }
    if (!base) return { kind: 'unrelated' };
    const [b, o, t] = [base, ours, theirs].map((x) => this.objects.get(x)!.files);
    const files: Files = {};
    const conflicts: string[] = [];
    for (const path of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
      const pick =
        o[path] === t[path]
          ? o[path]
          : o[path] === b[path]
          ? t[path]
          : t[path] === b[path]
          ? o[path]
          : null;
      if (pick === null) conflicts.push(path);
      else if (pick !== undefined) files[path] = pick;
    }
    return conflicts.length ? { kind: 'conflict', paths: conflicts } : { kind: 'clean', files };
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
      if (this.refs.has(key)) return json(409, {});
      const head = this.commit([], { 'README.md': `# ${body.name}\n` });
      this.refs.set(key, new Map([['main', head]]));
      return json(201, { name: body.name });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/forks$/)) && method === 'POST') {
      const source = `${m[1]}/${decodeURIComponent(m[2])}`;
      const target = `${body.organization}/${body.name}`;
      if (!this.refs.has(source)) return json(404, {});
      if (this.refs.has(target)) return json(409, {});
      this.refs.set(target, new Map(this.refs.get(source)!));
      this.forkOf.set(target, source);
      return json(202, { full_name: target });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/)) && method === 'GET') {
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (!this.refs.has(key)) return json(404, {});
      const parent = this.forkOf.get(key);
      return json(200, { fork: !!parent, parent: parent ? { full_name: parent } : null });
    }
    if (
      (m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/sync_fork\/(.+)$/)) &&
      method === 'POST'
    ) {
      // As Forgejo 17 answers (measured): a fast-forward of the fork's branch to its parent's is a
      // 204; a fork branch with commits of its own, one already up to date, or a repo that is not
      // a fork is a 400 and moves nothing.
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      const name = decodeURIComponent(m[3]);
      const parent = this.forkOf.get(key);
      const ours = this.refs.get(key)?.get(name);
      const theirs = parent ? this.refs.get(parent)?.get(name) : undefined;
      if (!ours || !theirs || ours === theirs || !this.ancestors(theirs).has(ours))
        return json(400, { message: 'You can’t sync this branch' });
      this.refs.get(key)!.set(name, theirs);
      return json(204);
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/branches$/)) && method === 'POST') {
      // As the real host answers: 409 for a taken name, 500 for a sha the repo does not hold.
      const key = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (this.branch(m[1], decodeURIComponent(m[2]), body.new_branch_name)) return json(409, {});
      if (!this.reachable(key, body.old_ref_name)) return json(500, {});
      this.refs.get(key)!.set(body.new_branch_name, body.old_ref_name);
      return json(201, { name: body.new_branch_name });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/))) {
      const b = this.branch(m[1], m[2], decodeURIComponent(m[3]));
      return b ? json(200, { commit: { id: b.head } }) : json(404, {});
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/))) {
      const sha = decodeURIComponent(m[3]);
      if (!this.reachable(`${m[1]}/${m[2]}`, sha)) return json(404, {});
      return json(200, { sha, parents: this.parents(sha)!.map((x) => ({ sha: x })) });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/))) {
      const ref = decodeURIComponent(m[3]);
      if (!this.reachable(`${m[1]}/${m[2]}`, ref)) return json(404, {});
      const files = this.objects.get(ref)!.files;
      const page = Number(url.searchParams.get('page') ?? '1');
      const tree =
        page === 1
          ? Object.entries(files).map(([fp, c]) => ({ path: fp, type: 'blob', sha: blob(c) }))
          : [];
      return json(200, { tree, total_count: Object.keys(files).length });
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/))) {
      for (const c of this.objects.values())
        for (const content of Object.values(c.files))
          if (blob(content) === m[3])
            return json(200, {
              content: Buffer.from(content).toString('base64'),
              encoding: 'base64',
            });
      return json(404, {});
    }
    if ((m = p.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/contents$/)) && method === 'POST') {
      const [org, slug] = [m[1], m[2]];
      this.beforeCommit?.();
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
      const sha = this.commit([base.head], files);
      this.refs.get(`${org}/${slug}`)!.set(target, sha);
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
type ApprovedRow = { forgejoCommitSha: string; version: string };
/** The latest approved version per block, as the PRIMARY has it. */
let approved: Record<string, ApprovedRow>;
/** The same as the REPLICA has it, when it lags the primary; `null` = caught up. */
let replicaApproved: Record<string, ApprovedRow> | null;
/** Pending publish requests by slug (the database allows one per app). */
let pending: Record<string, { id: string; submittedByUserId: number; fileSummary: unknown }>;
/** Publish requests filed by a staff on-behalf submit (`fileSummary.onBehalf`), on the primary. */
let filed: Array<{
  id: string;
  slug: string;
  status: string;
  fileSummary: unknown;
  appBlockId?: string;
}>;

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
  type Where = {
    appBlockId?: string;
    slug?: string;
    status?: string | { in: string[] };
    fileSummary?: { path: string[]; equals: string };
  };
  const onBehalfIdOf = (fileSummary: unknown) =>
    (fileSummary as { onBehalf?: { platformUpdateId?: string } } | null)?.onBehalf
      ?.platformUpdateId;
  const readers = (replica: boolean) => {
    const approvedFor = (where: Where) => {
      const id = where.appBlockId ?? blocks.find((x) => x.blockId === where.slug)?.id;
      return id ? ((replica ? replicaApproved : null) ?? approved)[id] : undefined;
    };
    const findFirst = async (a: { where: Where }) => {
      const w = a.where;
      if (w.fileSummary) {
        // `fileSummary->'onBehalf'->>'platformUpdateId' = …` among the listed statuses.
        expect(w.fileSummary.path).toEqual(['onBehalf', 'platformUpdateId']);
        const statuses = typeof w.status === 'object' ? w.status.in : [w.status];
        const hit = [...filed]
          .reverse()
          .find(
            (r) =>
              (!w.appBlockId || r.appBlockId === w.appBlockId) &&
              statuses.includes(r.status) &&
              onBehalfIdOf(r.fileSummary) === w.fileSummary!.equals
          );
        return hit ? { id: hit.id, status: hit.status } : null;
      }
      if (w.status === 'pending') {
        if (w.slug && pending[w.slug]) return { ...pending[w.slug] };
        const staff = filed.find((r) => r.slug === w.slug && r.status === 'pending');
        return staff
          ? { id: staff.id, submittedByUserId: MOD, fileSummary: staff.fileSummary }
          : null;
      }
      const hit = w.status === 'approved' ? approvedFor(w) : undefined;
      // The approved build is read back from the build repo at its commit (no stored bundle).
      return hit ? { ...hit, bundleKey: '', slug: w.slug ?? SLUG } : null;
    };
    const findMany = async (a: { where: Where }) => {
      const hit = a.where.status === 'approved' ? approvedFor(a.where) : undefined;
      return hit ? [{ version: hit.version }] : [];
    };
    return { findFirst, findMany };
  };
  for (const [client, replica] of [
    [dbMock.dbRead, true],
    [dbMock.dbWrite, false],
  ] as const) {
    const r = readers(replica);
    client.appBlockPublishRequest.findFirst.mockImplementation(r.findFirst);
    client.appBlockPublishRequest.findMany.mockImplementation(r.findMany);
  }
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
    CREATE TABLE "User" (
      id INT PRIMARY KEY, username TEXT, "isModerator" BOOLEAN NOT NULL,
      "bannedAt" TIMESTAMPTZ, "deletedAt" TIMESTAMPTZ
    );
    CREATE TABLE app_blocks (
      id TEXT PRIMARY KEY, block_id TEXT, fork_of_app_block_id TEXT, fork_of_commit_sha TEXT
    );
  `);
  for (const [id, u] of Object.entries(users))
    await pg.query(`INSERT INTO "User" (id, username, "isModerator") VALUES ($1, $2, $3)`, [
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
    UPDATE "User" SET "isModerator" = (id IN (${MOD}, ${EX_MOD})), "bannedAt" = NULL,
      "deletedAt" = NULL;`);
  flags.platformUpdates = true;
  commitSeq = 0;
  git = new FakeGit();
  approved = {};
  replicaApproved = null;
  pending = {};
  filed = [];
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
      touchesManifest: false,
    });
    expect(git.parents(result.commitSha)).toEqual([result.baseCommitSha]);
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
      touches_manifest: false,
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
      details: {
        slug: SLUG,
        updateId: result.id,
        byUsername: 'mod-ana',
        reason: REASON,
        touchesManifest: false,
      },
    });
  });

  it('a source repo that is not a fork of the build repo is cut from its main, even with an approved version elsewhere', async () => {
    git.addRepo(BUILD, SLUG, { 'package.json': PKG_OLD, 'src/app.ts': 'export const v = 9;\n' });
    approved.ab_app = { forgejoCommitSha: git.branch(BUILD, SLUG)!.head, version: '1.0.0' };
    await existingSourceRepo({ 'package.json': PKG_OLD, 'src/app.ts': 'export const v = 1;\n' });
    const main = git.branch(SRC, SLUG)!.head;
    const result = await pushAsMod();
    expect(result.baseCommitSha).toBe(main);
    expect(git.parents(result.commitSha)).toEqual([main]);
    expect(git.branch(SRC, SLUG, result.branch)!.files['src/app.ts']).toBe('export const v = 1;\n');
    expect(git.writes.filter((w) => w.path.includes('sync_fork'))).toEqual([]);
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
  /**
   * The build repo with two commits of history (the approved version is its head), and an owner's
   * checkout of it with one local commit of their own on top (to a file the update leaves alone).
   */
  function buildRepoWithOwnerCheckout() {
    git.addRepo(BUILD, SLUG, {
      'block.manifest.json': '{"blockId":"pixel-garden"}',
      'package.json': PKG_OLD,
      'README.md': '# Pixel Garden\n',
      '.env': 'K=1',
    });
    const head = git.devPush(BUILD, SLUG, { 'src/app.ts': 'export const v = 2;\n' }, 'v1.2.0');
    approved.ab_app = { forgejoCommitSha: head, version: '1.2.0' };
    const ownerCheckout = git.localCommit(head, { 'README.md': '# Pixel Garden (mine)\n' });
    return { head, ownerCheckout };
  }

  it('is created as a fork of the build repo, so the owner’s build-repo checkout merges the update cleanly', async () => {
    const { head, ownerCheckout } = buildRepoWithOwnerCheckout();
    const buildBefore = git.branch(BUILD, SLUG);

    const result = await pushAsMod();
    expect(result.seededSourceRepo).toBe(true);

    // The source repo's main IS the build repo's main: one history, no new root commit.
    expect(git.branch(SRC, SLUG)!.head).toBe(head);
    expect(result.baseCommitSha).toBe(head);
    expect(git.parents(result.commitSha)).toEqual([head]);
    expect(git.commits.filter((c) => c.branch !== 'main').map((c) => c.branch)).toEqual([
      result.branch,
    ]);

    // 🔴 The claim: the owner's checkout (build-repo history plus a local commit) merges the
    // recorded commit cleanly, keeping their change and taking the update's.
    expect(git.merge(ownerCheckout, result.commitSha)).toEqual({
      kind: 'clean',
      files: {
        'block.manifest.json': '{"blockId":"pixel-garden"}',
        'package.json': PKG_NEW,
        'README.md': '# Pixel Garden (mine)\n',
        '.env': 'K=1',
        'src/app.ts': 'export const v = 2;\n',
        'src/sdk-shim.ts': 'export {};\n',
      },
    });
    // Negative control for the merge model: a branch with its own root (what an "import" seed
    // makes) shares no history with the checkout, and git refuses it.
    git.addRepo('elsewhere', 'unrelated', { 'package.json': PKG_NEW });
    expect(git.merge(ownerCheckout, git.branch('elsewhere', 'unrelated')!.head)).toEqual({
      kind: 'unrelated',
    });

    // The build repo is read, never written: the only call to it is the fork, and its refs are
    // as they were.
    expect(git.writes.filter((w) => w.path.includes(`/${BUILD}/`))).toEqual([
      { method: 'POST', path: `/api/v1/repos/${BUILD}/${SLUG}/forks` },
    ]);
    expect(git.branch(BUILD, SLUG)).toEqual(buildBefore);

    const repo = (
      await pg.query(
        `SELECT slug, owner_user_id, app_block_id, origin, assistant_tree, last_assistant_commit_sha
         FROM app_source_repos`
      )
    ).rows as Array<Record<string, unknown>>;
    expect(repo).toEqual([
      {
        slug: SLUG,
        owner_user_id: OWNER,
        app_block_id: 'ab_app',
        origin: 'backfill',
        // App Assistant's base leaves out what a source repo never holds (`.env`).
        assistant_tree: {
          'block.manifest.json': blob('{"blockId":"pixel-garden"}'),
          'package.json': blob(PKG_OLD),
          'README.md': blob('# Pixel Garden\n'),
          'src/app.ts': blob('export const v = 2;\n'),
        },
        last_assistant_commit_sha: head,
      },
    ]);
    expect((await updateRows())[0]).toMatchObject({
      seeded_source_repo: true,
      status: 'pending',
      base_commit_sha: head,
    });
  });

  it('is cut from the latest APPROVED commit, not a newer unapproved push on the build repo’s main', async () => {
    const { head: approvedSha } = buildRepoWithOwnerCheckout();
    // The owner pushed again after approval; nobody has reviewed it.
    const unapproved = git.devPush(
      BUILD,
      SLUG,
      { 'src/app.ts': 'export const v = 3; // unreviewed\n' },
      'wip'
    );
    // Their checkout is at the build repo's main (the unapproved push is theirs), plus a local commit.
    const ownerCheckout = git.localCommit(unapproved, { 'README.md': '# Pixel Garden (mine)\n' });

    const result = await pushAsMod();
    expect(result.seededSourceRepo).toBe(true);
    expect(result.baseCommitSha).toBe(approvedSha);
    expect(git.parents(result.commitSha)).toEqual([approvedSha]);
    expect((await updateRows())[0]).toMatchObject({ base_commit_sha: approvedSha });
    // The update holds the approved code plus its change, none of the unapproved push.
    expect(git.branch(SRC, SLUG, result.branch)!.files).toEqual({
      'block.manifest.json': '{"blockId":"pixel-garden"}',
      'package.json': PKG_NEW,
      'README.md': '# Pixel Garden\n',
      '.env': 'K=1',
      'src/app.ts': 'export const v = 2;\n',
      'src/sdk-shim.ts': 'export {};\n',
    });
    // The source repo's main stays where the fork put it: the git host cannot move a branch back.
    expect(git.branch(SRC, SLUG)!.head).toBe(unapproved);

    // The owner's checkout merges it cleanly, keeping their unapproved push and their local commit.
    expect(git.merge(ownerCheckout, result.commitSha)).toEqual({
      kind: 'clean',
      files: {
        'block.manifest.json': '{"blockId":"pixel-garden"}',
        'package.json': PKG_NEW,
        'README.md': '# Pixel Garden (mine)\n',
        '.env': 'K=1',
        'src/app.ts': 'export const v = 3; // unreviewed\n',
        'src/sdk-shim.ts': 'export {};\n',
      },
    });
  });

  it('is planned against the APPROVED tree: a file the unapproved push also changed still updates', async () => {
    const { head: approvedSha } = buildRepoWithOwnerCheckout();
    git.devPush(BUILD, SLUG, { 'package.json': '{"wip":true}' }, 'wip');
    const result = await pushAsMod();
    expect(result.baseCommitSha).toBe(approvedSha);
    expect(result.paths).toEqual([
      { path: 'src/sdk-shim.ts', operation: 'create' },
      { path: 'package.json', operation: 'update' },
    ]);
    expect(git.branch(SRC, SLUG, result.branch)!.files['package.json']).toBe(PKG_NEW);
  });

  it('an approved commit the new source repo does not hold refuses the push', async () => {
    const { head } = buildRepoWithOwnerCheckout();
    // Recorded as approved, but on no branch of the build repo, so the fork does not have it.
    approved.ab_app = {
      forgejoCommitSha: git.localCommit(head, { 'src/app.ts': 'gone\n' }),
      version: '1.3.0',
    };
    await expect(pushAsMod()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The app’s approved version is not in its source repo yet; nothing was pushed',
    });
    expect([...git.refs.get(`${SRC}/${SLUG}`)!.keys()]).toEqual(['main']);
    expect(git.commits.filter((c) => c.branch !== 'main')).toEqual([]);
    expect(await updateRows()).toEqual([]);
  });

  it('a retry after a first push that failed once the repo existed is still cut from the APPROVED commit', async () => {
    const { head: approvedSha } = buildRepoWithOwnerCheckout();
    const unapproved = git.devPush(BUILD, SLUG, { 'src/app.ts': 'export const v = 3;\n' }, 'wip');
    // The fork is made, then the git host fails the commit.
    git.beforeCommit = () => {
      git.beforeCommit = null;
      throw new Error('git host down');
    };
    await expect(pushAsMod()).rejects.toThrow();
    expect(await updateRows()).toEqual([]);
    expect(git.branch(SRC, SLUG)!.head).toBe(unapproved);

    const retry = await pushAsMod();
    expect(retry.seededSourceRepo).toBe(false);
    expect(retry.baseCommitSha).toBe(approvedSha);
    expect(git.parents(retry.commitSha)).toEqual([approvedSha]);
    expect(git.branch(SRC, SLUG, retry.branch)!.files['src/app.ts']).toBe('export const v = 2;\n');
    expect((await updateRows())[0]).toMatchObject({ base_commit_sha: approvedSha });
  });

  it('a LATER update to that repo is cut from the approved commit, not the fork’s main', async () => {
    const { head: approvedSha } = buildRepoWithOwnerCheckout();
    const unapproved = git.devPush(BUILD, SLUG, { 'src/app.ts': 'export const v = 3;\n' }, 'wip');
    const first = await pushAsMod();
    expect(first.seededSourceRepo).toBe(true);
    expect(git.branch(SRC, SLUG)!.head).toBe(unapproved);

    const later = await svc.pushPlatformUpdate({
      staffUserId: MOD,
      app: { slug: SLUG },
      reason: REASON,
      changes: [put('README.md', '# Pixel Garden v2\n')],
    });
    expect(later.seededSourceRepo).toBe(false);
    expect(later.baseCommitSha).toBe(approvedSha);
    expect(git.parents(later.commitSha)).toEqual([approvedSha]);
    expect(git.branch(SRC, SLUG, later.branch)!.files['src/app.ts']).toBe('export const v = 2;\n');
  });

  it('a later update after a NEWER approval syncs the fork from the build repo and is cut from it', async () => {
    const { head: firstApproved } = buildRepoWithOwnerCheckout();
    const first = await pushAsMod();
    expect(first.baseCommitSha).toBe(firstApproved);

    // The owner ships 1.3.0 to the build repo, it is approved, then they push more, unreviewed.
    const newer = git.devPush(BUILD, SLUG, { 'src/app.ts': 'export const v = 4;\n' }, 'v1.3.0');
    approved.ab_app = { forgejoCommitSha: newer, version: '1.3.0' };
    const unapproved = git.devPush(BUILD, SLUG, { 'src/app.ts': 'export const v = 5;\n' }, 'wip');
    const ownerCheckout = git.localCommit(unapproved, { 'README.md': '# Pixel Garden (mine)\n' });
    const buildBefore = git.branch(BUILD, SLUG);

    const later = await pushAsMod();
    expect(later.baseCommitSha).toBe(newer);
    expect(git.parents(later.commitSha)).toEqual([newer]);
    expect(git.branch(SRC, SLUG, later.branch)!.files).toEqual({
      'block.manifest.json': '{"blockId":"pixel-garden"}',
      'package.json': PKG_NEW,
      'README.md': '# Pixel Garden\n',
      '.env': 'K=1',
      'src/app.ts': 'export const v = 4;\n',
      'src/sdk-shim.ts': 'export {};\n',
    });
    // The sync fast-forwarded the fork's main (the build repo is only read).
    expect(git.branch(SRC, SLUG)!.head).toBe(unapproved);
    expect(git.branch(BUILD, SLUG)).toEqual(buildBefore);
    expect(git.writes.filter((w) => w.path.includes(`/${BUILD}/`))).toEqual([
      { method: 'POST', path: `/api/v1/repos/${BUILD}/${SLUG}/forks` },
    ]);
    // An owner's checkout at the build repo's main merges it cleanly.
    expect(git.merge(ownerCheckout, later.commitSha)).toEqual({
      kind: 'clean',
      files: {
        'block.manifest.json': '{"blockId":"pixel-garden"}',
        'package.json': PKG_NEW,
        'README.md': '# Pixel Garden (mine)\n',
        '.env': 'K=1',
        'src/app.ts': 'export const v = 5;\n',
        'src/sdk-shim.ts': 'export {};\n',
      },
    });
  });

  it('a newer approval the fork cannot be synced to (its main has commits of its own) refuses the push', async () => {
    buildRepoWithOwnerCheckout();
    await pushAsMod();
    // Someone pushed to the source repo's main, so it no longer fast-forwards to the build repo's.
    const own = git.devPush(SRC, SLUG, { 'NOTES.md': 'mine\n' }, 'notes');
    const newer = git.devPush(BUILD, SLUG, { 'src/app.ts': 'export const v = 4;\n' }, 'v1.3.0');
    approved.ab_app = { forgejoCommitSha: newer, version: '1.3.0' };
    const branchesBefore = [...git.refs.get(`${SRC}/${SLUG}`)!.entries()];
    const rowsBefore = await updateRows();

    await expect(pushAsMod()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The app’s approved version is not in its source repo yet; nothing was pushed',
    });
    expect([...git.refs.get(`${SRC}/${SLUG}`)!.entries()]).toEqual(branchesBefore);
    expect(git.branch(SRC, SLUG)!.head).toBe(own);
    expect(await updateRows()).toEqual(rowsBefore);
  });

  it('an update to the same file the owner changed is a conflict, not a silent overwrite', async () => {
    const { head } = buildRepoWithOwnerCheckout();
    const ownerCheckout = git.localCommit(head, { 'package.json': '{"mine":true}' });
    const result = await pushAsMod();
    expect(git.merge(ownerCheckout, result.commitSha)).toEqual({
      kind: 'conflict',
      paths: ['package.json'],
    });
  });

  it('a repo under the name that is not a fork of the build repo is never seeded on top of', async () => {
    buildRepoWithOwnerCheckout();
    // A repo an earlier, interrupted create left behind: no row, not a fork.
    git.addRepo(SRC, SLUG, { 'README.md': '# stray\n' });
    await expect(pushAsMod()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The app’s source repo could not be created; try again',
    });
    expect(git.commits).toEqual(git.commits.filter((c) => c.branch === 'main'));
    expect((await pg.query(`SELECT * FROM app_source_repos`)).rows).toEqual([]);
    expect(await updateRows()).toEqual([]);
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

describe('the record', () => {
  it('names the commit’s ACTUAL parent when main moved between the read and the write', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD, 'README.md': 'r\n' });
    const readHead = git.branch(SRC, SLUG)!.head;
    let moved: string | null = null;
    git.beforeCommit = () => {
      git.beforeCommit = null;
      // A developer push to a file the update does not touch: the compare-and-set lets it through.
      moved = git.devPush(SRC, SLUG, { 'README.md': 'r2\n' }, 'docs');
    };
    const result = await pushAsMod();
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(readHead);
    expect(git.parents(result.commitSha)).toEqual([moved]);
    expect(result.baseCommitSha).toBe(moved);
    expect((await updateRows())[0]).toMatchObject({ base_commit_sha: moved });
  });

  it('touchesManifest: the manifest, and a storage hook file the manifest declares', async () => {
    const manifest = JSON.stringify({
      blockId: SLUG,
      storage: { collections: { notes: { hook: { file: 'hooks/notes.js', sha256: 'x' } } } },
    });
    await existingSourceRepo({
      'package.json': PKG_OLD,
      'block.manifest.json': manifest,
      'hooks/notes.js': 'export default () => true;\n',
    });
    const push = (changes: Parameters<typeof svc.pushPlatformUpdate>[0]['changes']) =>
      svc.pushPlatformUpdate({ staffUserId: MOD, app: { slug: SLUG }, reason: REASON, changes });

    const plain = await push([put('package.json', PKG_NEW)]);
    const hook = await push([put('hooks/notes.js', 'export default () => false;\n')]);
    const man = await push([put('block.manifest.json', manifest.replace('notes', 'memos'))]);
    expect([plain, hook, man].map((r) => r.touchesManifest)).toEqual([false, true, true]);

    const listed = (await caller(OWNER).listPending({ slug: SLUG })).updates;
    expect(listed.map((u) => [u.id, u.paths, u.touchesManifest])).toEqual([
      [plain.id, [{ path: 'package.json', operation: 'update' }], false],
      [hook.id, [{ path: 'hooks/notes.js', operation: 'update' }], true],
      [man.id, [{ path: 'block.manifest.json', operation: 'update' }], true],
    ]);
    expect(
      createNotification.mock.calls.map(
        (c) => (c[0] as { details: { touchesManifest: boolean } }).details.touchesManifest
      )
    ).toEqual([false, true, true]);
  });

  it('touchesManifest is true when the manifest on main cannot be parsed', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD, 'block.manifest.json': '{not json' });
    expect((await pushAsMod()).touchesManifest).toBe(true);
  });

  it('a path a source repo never holds is refused in any letter case', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    for (const p of ['.ENV', '.Env.local'])
      await expect(
        svc.pushPlatformUpdate({
          staffUserId: MOD,
          app: { slug: SLUG },
          reason: REASON,
          changes: [put(p, 'K=1')],
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `${p} is a file a source repo never holds`,
      });
    expect(git.commits).toEqual([]);
    expect(await updateRows()).toEqual([]);
  });
});

describe('the owner API', () => {
  it('lists this app’s pending updates, to the owner and an accepted collaborator only', async () => {
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
      paths:
        i === 0
          ? [
              { path: 'src/sdk-shim.ts', operation: 'create' },
              { path: 'package.json', operation: 'update' },
            ]
          : [{ path: 'PRIVACY.md', operation: 'create' }],
      touchesManifest: false,
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

describe('verifyCommit answers false for an update that is no longer staff’s', () => {
  it('a superseded update is not verified (its author still is staff)', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod();
    // Positive control: verified before the withdrawal, through the same call.
    expect(
      await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: pushed.commitSha })
    ).toMatchObject({ verified: true });
    await caller(MOD).supersede({ id: pushed.id });
    expect(
      await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: pushed.commitSha })
    ).toMatchObject({
      verified: false,
      update: { id: pushed.id, status: 'superseded', by: { verifiedStaff: true } },
    });
  });

  it('an author who is banned now is not verified, though still flagged a moderator', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod(EX_MOD);
    await pg.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [EX_MOD]);
    expect(
      await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: pushed.commitSha })
    ).toMatchObject({
      verified: false,
      update: { id: pushed.id, by: { username: 'ex-mod-bo', verifiedStaff: false } },
    });
    expect((await caller(OWNER).listPending({ slug: SLUG })).updates[0].by.verifiedStaff).toBe(
      false
    );
  });

  it('a commit someone added on top of the update branch is not verified; the record keeps the staff commit', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod();
    const onTop = git.devPush(
      SRC,
      SLUG,
      { 'src/extra.ts': 'export const x = 1;\n' },
      'more changes',
      pushed.branch
    );
    expect(git.branch(SRC, SLUG, pushed.branch)!.head).toBe(onTop);
    expect(await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: onTop })).toEqual({
      verified: false,
      update: null,
    });
    expect((await caller(OWNER).listPending({ slug: SLUG })).updates).toMatchObject([
      { id: pushed.id, commitSha: pushed.commitSha },
    ]);
  });
});

describe('supersede and modList (staff)', () => {
  it('supersede withdraws a pending update: off the owner list, repeat is a no-op, merged refuses', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod();
    await expect(caller(NOT_MOD).supersede({ id: pushed.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await caller(MOD).supersede({ id: pushed.id })).toEqual({
      id: pushed.id,
      status: 'superseded',
    });
    expect((await updateRows())[0]).toMatchObject({
      status: 'superseded',
      resolved_by_user_id: MOD,
    });
    expect(await caller(OWNER).listPending({ slug: SLUG })).toEqual({ updates: [] });
    expect(await caller(EX_MOD).supersede({ id: pushed.id })).toEqual({
      id: pushed.id,
      status: 'superseded',
    });
    // The no-op left the record as the first supersede wrote it.
    expect((await updateRows())[0]).toMatchObject({ resolved_by_user_id: MOD });
    // An owner cannot resolve a withdrawn update.
    await expect(
      caller(OWNER).resolve({ id: pushed.id, outcome: 'merged', mergeCommitSha: 'e'.repeat(40) })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // This database has no `shipped` columns, so whether a merged update shipped cannot be read
    // and it is refused (with them, an unshipped one is withdrawn:
    // platform-update-bundle-check.pglite.test.ts).
    const merged = await pushAsMod();
    await caller(OWNER).resolve({
      id: merged.id,
      outcome: 'merged',
      mergeCommitSha: 'f'.repeat(40),
    });
    await expect(caller(MOD).supersede({ id: merged.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This update is already merged',
    });
  });

  it('modList: every update of the app, newest first, with who pushed and the merge commit', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const a = await pushAsMod();
    const b = await pushAsMod(EX_MOD);
    const c = await pushAsMod();
    await caller(MOD).supersede({ id: a.id });
    await caller(OWNER).resolve({ id: b.id, outcome: 'merged', mergeCommitSha: '9'.repeat(40) });
    // Order by created_at: make it strictly increasing regardless of clock resolution.
    for (const [i, id] of [a.id, b.id, c.id].entries())
      await pg.query(
        `UPDATE app_platform_updates SET created_at = '2027-01-01T00:00:0${i}Z' WHERE id = $1`,
        [id]
      );
    await expect(caller(OWNER).modList({ slug: SLUG })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const { updates } = await caller(MOD).modList({ slug: SLUG });
    expect(updates.map((u) => [u.id, u.status, u.staffUserId, u.mergeCommitSha])).toEqual([
      [c.id, 'pending', MOD, null],
      [b.id, 'merged', EX_MOD, '9'.repeat(40)],
      [a.id, 'superseded', MOD, null],
    ]);
    flags.platformUpdates = false;
    expect(await caller(MOD).modList({ slug: SLUG })).toEqual({ updates: [] });
  });
});

describe('resolve: conflicted, then merged by hand', () => {
  it('pending → conflicted → merged; repeating conflicted is a no-op', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod();
    expect(
      (await caller(OWNER).resolve({ id: pushed.id, outcome: 'conflicted' })).update
    ).toMatchObject({ status: 'conflicted' });
    expect((await updateRows())[0]).toMatchObject({
      status: 'conflicted',
      merge_commit_sha: null,
      resolved_by_user_id: OWNER,
    });
    // 🔴 Still listed, as conflicted: the owner has not merged it, so every later pull must see it
    // again (re-print the hand-merge instructions) and every later submit must still refuse.
    expect((await caller(OWNER).listPending({ slug: SLUG })).updates).toMatchObject([
      { id: pushed.id, commitSha: pushed.commitSha, status: 'conflicted' },
    ]);
    expect(
      (await caller(EDITOR).resolve({ id: pushed.id, outcome: 'conflicted' })).update
    ).toMatchObject({ status: 'conflicted' });
    // The no-op wrote nothing: the resolver is still the owner.
    expect((await updateRows())[0]).toMatchObject({ resolved_by_user_id: OWNER });

    const MERGE = '7'.repeat(40);
    expect(
      (
        await caller(EDITOR).resolve({
          id: pushed.id,
          outcome: 'merged',
          mergeCommitSha: MERGE,
        })
      ).update
    ).toMatchObject({ status: 'merged' });
    expect((await updateRows())[0]).toMatchObject({
      status: 'merged',
      merge_commit_sha: MERGE,
      resolved_by_user_id: EDITOR,
    });
    // Merged: off the owner list.
    expect(await caller(OWNER).listPending({ slug: SLUG })).toEqual({ updates: [] });
  });

  it('the owner list is OPEN updates: pending and conflicted, oldest first; never merged or superseded', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const a = await pushAsMod(); // stays pending
    const b = await pushAsMod(); // → conflicted
    const c = await pushAsMod(); // → merged
    const d = await pushAsMod(); // → superseded
    const e = await pushAsMod(); // → conflicted, then superseded
    await caller(OWNER).resolve({ id: b.id, outcome: 'conflicted' });
    await caller(OWNER).resolve({ id: c.id, outcome: 'merged', mergeCommitSha: '8'.repeat(40) });
    await caller(MOD).supersede({ id: d.id });
    await caller(OWNER).resolve({ id: e.id, outcome: 'conflicted' });
    await caller(MOD).supersede({ id: e.id });
    // Order by created_at, made strictly increasing with b OLDEST, so a list that ignored the
    // order (or sorted by id) would not pass by accident.
    for (const [i, id] of [b.id, a.id, c.id, d.id, e.id].entries())
      await pg.query(
        `UPDATE app_platform_updates SET created_at = '2027-01-01T00:00:0${i}Z' WHERE id = $1`,
        [id]
      );
    const { updates } = await caller(OWNER).listPending({ slug: SLUG });
    expect(updates.map((u) => [u.id, u.status])).toEqual([
      [b.id, 'conflicted'],
      [a.id, 'pending'],
    ]);
  });
});

describe('the flag off, for the owner procedures', () => {
  it('verifyCommit answers not verified and resolve refuses, even for a real update', async () => {
    await existingSourceRepo({ 'package.json': PKG_OLD });
    const pushed = await pushAsMod();
    flags.platformUpdates = false;
    expect(await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: pushed.commitSha })).toEqual({
      verified: false,
      update: null,
    });
    await expect(
      caller(OWNER).resolve({ id: pushed.id, outcome: 'conflicted' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Platform updates are not enabled' });
    expect((await updateRows())[0]).toMatchObject({ status: 'pending' });
    // Positive control: the same calls answer once the flag is back on.
    flags.platformUpdates = true;
    expect(
      await caller(OWNER).verifyCommit({ slug: SLUG, commitSha: pushed.commitSha })
    ).toMatchObject({ verified: true });
  });
});

const JSZip = (await import('jszip')).default;
const submitSvc = await import('~/server/services/blocks/app-platform-update-submit.service');

describe('submit on the owner’s behalf', () => {
  const PUBREQ = 'pubreq_01JONBEHALF0000000000000000';
  const MANIFEST = '{"blockId":"pixel-garden","name":"Pixel Garden","version":"1.2.0"}';

  /** The approved build in the build repo; the source repo is then forked from it by the push. */
  function approvedBuild(files: Record<string, string> = {}) {
    git.addRepo(BUILD, SLUG, {
      'block.manifest.json': MANIFEST,
      'package.json': PKG_OLD,
      'index.html': '<p>approved</p>',
      ...files,
    });
    approved.ab_app = { forgejoCommitSha: git.branch(BUILD, SLUG)!.head, version: '1.2.0' };
  }

  /** `submitVersion`, recorded: what the staff submit hands the ordinary submit path. */
  function recordingSubmit() {
    const calls: SubmitVersionParams[] = [];
    const submitVersion = async (params: SubmitVersionParams) => {
      calls.push(params);
      const publishRequestId = calls.length === 1 ? PUBREQ : `${PUBREQ}_${calls.length}`;
      // The request as the primary then holds it, `fileSummary.onBehalf` and all.
      filed.push({
        id: publishRequestId,
        slug: SLUG,
        appBlockId: 'ab_app',
        status: 'pending',
        fileSummary: { files: [], onBehalf: { ...params.onBehalf, staffUserId: MOD } },
      });
      return { publishRequestId, version: '1.2.1' };
    };
    return { calls, deps: { submitVersion } };
  }

  const bundleText = async (buf: Buffer) => {
    const zip = await JSZip.loadAsync(buf);
    const out: Record<string, string> = {};
    for (const [path, entry] of Object.entries(zip.files))
      if (!entry.dir) out[path] = await entry.async('string');
    return out;
  };

  it('a non-moderator is refused, by the router and by the service’s database re-check', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    await expect(caller(NOT_MOD).submitOnBehalf({ id: pushed.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const { calls, deps } = recordingSubmit();
    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: NOT_MOD, id: pushed.id }, deps)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only Civitai staff can submit updates',
    });
    expect(calls).toEqual([]);
  });

  it('the flag off: refused', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    flags.platformUpdates = false;
    await expect(caller(MOD).submitOnBehalf({ id: pushed.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Platform updates are not enabled',
    });
    expect((await updateRows())[0]).toMatchObject({ status: 'pending' });
    expect(filed).toEqual([]);
  });

  it('🔴 the owner has a pending request: refused with the exact message, and theirs is untouched', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    pending[SLUG] = { id: 'pubreq_owner', submittedByUserId: OWNER, fileSummary: { files: [] } };
    const { calls, deps } = recordingSubmit();
    createNotification.mockClear();
    const writes = ['update', 'updateMany', 'create', 'delete', 'deleteMany'] as const;
    for (const write of writes) dbMock.dbWrite.appBlockPublishRequest[write].mockClear();

    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The owner has a pending publish request for this app. The update stays on its branch ' +
        'and merges on their next submit, or retry after that request is reviewed.',
    });
    expect(calls).toEqual([]);
    // Nothing touched the owner's request: no publish-request write of any kind.
    for (const write of writes)
      expect(dbMock.dbWrite.appBlockPublishRequest[write]).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect((await updateRows())[0]).toMatchObject({ status: 'pending' });

    // Positive control: the same call files once the owner's request is reviewed.
    delete pending[SLUG];
    await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps);
    expect(calls).toHaveLength(1);
  });

  it('files the approved build plus the update, as the moderator, for the owner, and tells the owner', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    // The owner's unsubmitted work on the source repo's main never reaches the bundle.
    git.devPush(SRC, SLUG, { 'wip.ts': 'unsubmitted\n' }, 'wip');
    const { calls, deps } = recordingSubmit();
    createNotification.mockClear();

    const result = await submitSvc.submitPlatformUpdateOnBehalf(
      { staffUserId: MOD, id: pushed.id },
      deps
    );
    expect(result).toEqual({
      updateId: pushed.id,
      slug: SLUG,
      publishRequestId: PUBREQ,
      version: '1.2.1',
    });

    expect(calls).toHaveLength(1);
    const { bundleBuffer, ...params } = calls[0];
    expect(params).toEqual({
      submittedByUserId: MOD,
      submitterIsModerator: true,
      submittedOnBehalf: true,
      onBehalf: {
        platformUpdateId: pushed.id,
        staffUsername: 'mod-ana',
        ownerUserId: OWNER,
        ownerUsername: 'owner-olga',
      },
    });
    expect(await bundleText(bundleBuffer)).toEqual({
      'block.manifest.json':
        '{\n  "blockId": "pixel-garden",\n  "name": "Pixel Garden",\n  "version": "1.2.1"\n}\n',
      'index.html': '<p>approved</p>',
      'package.json': PKG_NEW,
      'src/sdk-shim.ts': 'export {};\n',
    });

    // The update stays pending for the owner's own checkout.
    expect((await updateRows())[0]).toMatchObject({ status: 'pending' });

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      userId: OWNER,
      type: 'app-platform-update-submitted',
      key: `app-platform-update-submitted:${PUBREQ}`,
      details: {
        slug: SLUG,
        updateId: pushed.id,
        publishRequestId: PUBREQ,
        version: '1.2.1',
        byUsername: 'mod-ana',
        reason: REASON,
      },
    });

    // A second submit while that request is pending is refused.
    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `This update was already submitted (${PUBREQ}, pending)`,
    });
    expect(calls).toHaveLength(1);
  });

  it('"already submitted" is read from the publish requests: pending or approved refuses, rejected does not', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    const { calls, deps } = recordingSubmit();
    await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps);

    filed[0]!.status = 'approved';
    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `This update was already submitted (${PUBREQ}, approved)`,
    });
    expect(calls).toHaveLength(1);

    // Another update's request never counts against this one.
    filed[0]!.fileSummary = { onBehalf: { platformUpdateId: 'apu_someone_else' } };
    await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps);
    expect(calls).toHaveLength(2);

    // A rejected one does not either: the update may be submitted again.
    filed.length = 0;
    filed.push({
      id: PUBREQ,
      slug: SLUG,
      status: 'rejected',
      fileSummary: { onBehalf: { platformUpdateId: pushed.id } },
    });
    await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps);
    expect(calls).toHaveLength(3);
  });

  it('🔴 builds on the approved version the PRIMARY has, when the replica still has the one before', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    // The owner's 1.3.0 was approved a moment ago; the replica still says 1.2.0.
    const before = approved.ab_app!;
    const later = git.devPush(
      BUILD,
      SLUG,
      {
        'block.manifest.json': MANIFEST.replace('1.2.0', '1.3.0'),
        'index.html': '<p>owner 1.3.0</p>',
      },
      'v1.3.0'
    );
    approved.ab_app = { forgejoCommitSha: later, version: '1.3.0' };
    replicaApproved = { ab_app: before };
    const { calls, deps } = recordingSubmit();

    await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps);
    expect(calls).toHaveLength(1);
    // The owner's 1.3.0 files, the update applied, and a version above 1.3.0: nothing rolled back.
    expect(await bundleText(calls[0]!.bundleBuffer)).toEqual({
      'block.manifest.json':
        '{\n  "blockId": "pixel-garden",\n  "name": "Pixel Garden",\n  "version": "1.3.1"\n}\n',
      'index.html': '<p>owner 1.3.0</p>',
      'package.json': PKG_NEW,
      'src/sdk-shim.ts': 'export {};\n',
    });
  });

  it('refuses when the approved build differs from what the update was written against', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    // A later approved version changed package.json after the source repo was forked.
    const later = git.devPush(BUILD, SLUG, { 'package.json': '{"approved":"later"}' }, 'v1.3.0');
    approved.ab_app = { forgejoCommitSha: later, version: '1.3.0' };
    const { calls, deps } = recordingSubmit();
    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The approved version differs from what the update was written against in ' +
        'package.json; the owner has to merge this update and submit it themselves',
    });
    expect(calls).toEqual([]);
  });

  it('a staff submission already pending for the app: a second update is refused as such', async () => {
    approvedBuild();
    const first = await pushAsMod();
    const second = await pushAsMod(MOD, 'A second fix');
    const { calls, deps } = recordingSubmit();
    await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: first.id }, deps);
    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: second.id }, deps)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'A staff submission for this app is already waiting for review; retry after it is reviewed.',
    });
    expect(calls).toHaveLength(1);
  });

  it('a withdrawn update is refused', async () => {
    approvedBuild();
    const pushed = await pushAsMod();
    await svc.supersedePlatformUpdate({ staffUserId: MOD, id: pushed.id });
    const { calls, deps } = recordingSubmit();
    await expect(
      submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'This update was withdrawn' });
    expect(calls).toEqual([]);
  });

  describe('🔴 the update’s AUTHOR must be verified staff now (PR #10605)', () => {
    const AUTHOR_REFUSAL = {
      code: 'FORBIDDEN',
      message:
        "This update's author is no longer verified Civitai staff; withdraw it or push a new one",
    };

    it('an author who is no longer a moderator: refused, nothing filed, nobody told', async () => {
      approvedBuild();
      const pushed = await pushAsMod(EX_MOD);
      await pg.query(`UPDATE "User" SET "isModerator" = false WHERE id = $1`, [EX_MOD]);
      const { calls, deps } = recordingSubmit();
      createNotification.mockClear();

      await expect(
        submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
      ).rejects.toMatchObject(AUTHOR_REFUSAL);
      expect(calls).toEqual([]);
      expect(filed).toEqual([]);
      expect(createNotification).not.toHaveBeenCalled();
      expect((await updateRows())[0]).toMatchObject({ status: 'pending' });

      // Positive control: the same submit by the same moderator proceeds once the author is
      // staff again.
      await pg.query(`UPDATE "User" SET "isModerator" = true WHERE id = $1`, [EX_MOD]);
      await submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps);
      expect(calls).toHaveLength(1);
    });

    it('an author who is banned now, though still flagged a moderator: refused', async () => {
      approvedBuild();
      const pushed = await pushAsMod(EX_MOD);
      await pg.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [EX_MOD]);
      const { calls, deps } = recordingSubmit();
      await expect(
        submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
      ).rejects.toMatchObject(AUTHOR_REFUSAL);
      expect(calls).toEqual([]);
      expect(filed).toEqual([]);
    });

    it('an author who is deleted now: refused', async () => {
      approvedBuild();
      const pushed = await pushAsMod(EX_MOD);
      await pg.query(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [EX_MOD]);
      const { calls, deps } = recordingSubmit();
      await expect(
        submitSvc.submitPlatformUpdateOnBehalf({ staffUserId: MOD, id: pushed.id }, deps)
      ).rejects.toMatchObject(AUTHOR_REFUSAL);
      expect(calls).toEqual([]);
    });
  });
});

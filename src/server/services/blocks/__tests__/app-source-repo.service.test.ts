import { TRPCError } from '@trpc/server';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppAccessService from '~/server/services/blocks/app-access.service';

/**
 * Source repos (`civitai-apps-src/<slug>`) end to end against a FAKE git host at the HTTP boundary
 * (global `fetch`), an in-memory `app_source_repos` table behind the canonical db mock's raw SQL,
 * and an in-memory redis for the writer lock.
 *
 * The fake models what the writer relies on: a branch per repo, the contents API refusing a
 * stale blob `sha` (422), a `create` of a path that exists (422), and an `update`/`delete` of a
 * path that is gone (404) — the compare-and-set Gitea 1.22's `ChangeRepoFiles` applies. Those
 * statuses are read from that version's source, not measured against the deployed instance.
 *
 * Claims:
 *   - a fork's repo is created and seeded, the Forked-From-* trailers from the lineage passed in;
 *   - an App Assistant save lands as one commit, by the assistant, on behalf of the user;
 *   - a developer push and an assistant save never lose either side;
 *   - access: unbound owner, bound owner, accepted collaborator, a transfer, a squatted slug;
 *   - a ban removes the collaborator rows;
 *   - the backfill's second run makes zero writes;
 *   - a missing table turns everything off, with no git-host call.
 */

// ---------------------------------------------------------------------------
// The fake git host
// ---------------------------------------------------------------------------

type Commit = {
  sha: string;
  branch: string;
  message: string;
  author: { name: string; email: string } | null;
  files: Record<string, string>; // path -> content (the tree after the commit)
};

const HOST = 'https://git.fake.test';
let commitSeq = 0;
const nextSha = () => (++commitSeq).toString(16).padStart(40, '0');

const { createHash } = await import('crypto');
const blob = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');

class FakeGit {
  orgs = new Set<string>();
  /** `org/slug` → branch → { head, files } */
  repos = new Map<string, Map<string, { head: string; files: Record<string, string> }>>();
  collaborators = new Map<string, string>(); // `org/slug/user` → permission
  commits: Commit[] = [];
  /** Every request that is not a GET. */
  writes: Array<{ method: string; path: string }> = [];
  /** Every request. */
  calls: Array<{ method: string; path: string }> = [];

  branch(org: string, slug: string, name = 'main') {
    return this.repos.get(`${org}/${slug}`)?.get(name) ?? null;
  }

  /** What `git push` from a developer does: a new commit on the branch with these files. */
  devPush(org: string, slug: string, change: Record<string, string | null>, name = 'main') {
    const b = this.branch(org, slug, name)!;
    const files = { ...b.files };
    for (const [p, c] of Object.entries(change)) {
      if (c === null) delete files[p];
      else files[p] = c;
    }
    b.files = files;
    b.head = nextSha();
  }

  async handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    this.calls.push({ method, path });
    if (method !== 'GET') this.writes.push({ method, path });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const json = (status: number, data?: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status });
    let m: RegExpMatchArray | null;

    if (method === 'POST' && path === '/api/v1/orgs') {
      if (this.orgs.has(body.username)) return json(422, { message: 'exists' });
      this.orgs.add(body.username);
      return json(201, {});
    }
    if ((m = path.match(/^\/api\/v1\/orgs\/([^/]+)\/repos$/)) && method === 'POST') {
      const key = `${m[1]}/${body.name}`;
      if (this.repos.has(key)) return json(409, { message: 'exists' });
      const files = { 'README.md': `# ${body.name}\n` };
      this.repos.set(key, new Map([['main', { head: nextSha(), files }]]));
      return json(201, { name: body.name });
    }
    if ((m = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/))) {
      const b = this.branch(m[1], m[2], decodeURIComponent(m[3]));
      return b ? json(200, { commit: { id: b.head } }) : json(404, { message: 'no branch' });
    }
    if ((m = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/))) {
      const ref = decodeURIComponent(m[3]);
      const branches = this.repos.get(`${m[1]}/${m[2]}`);
      const b = [...(branches?.values() ?? [])].find((x) => x.head === ref);
      if (!b) return json(404, { message: 'no ref' });
      const page = Number(url.searchParams.get('page') ?? '1');
      const tree =
        page === 1
          ? Object.entries(b.files).map(([p, c]) => ({ path: p, type: 'blob', sha: blob(c) }))
          : [];
      return json(200, { tree, total_count: Object.keys(b.files).length });
    }
    if ((m = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/contents$/)) && method === 'POST') {
      const [org, slug] = [m[1], m[2]];
      const base = this.branch(org, slug, body.branch);
      if (!base) return json(404, { message: 'branch does not exist' });
      const files = { ...base.files };
      for (const op of body.files as Array<{
        operation: string;
        path: string;
        content?: string;
        sha?: string;
      }>) {
        const exists = op.path in files;
        if (op.operation === 'create') {
          if (exists) return json(422, { message: 'file already exists' });
          files[op.path] = Buffer.from(op.content!, 'base64').toString('utf8');
        } else {
          if (!exists) return json(404, { message: 'file does not exist' });
          if (blob(files[op.path]) !== op.sha) return json(422, { message: 'sha does not match' });
          if (op.operation === 'delete') delete files[op.path];
          else files[op.path] = Buffer.from(op.content!, 'base64').toString('utf8');
        }
      }
      const target = body.new_branch ?? body.branch;
      if (body.new_branch && this.branch(org, slug, body.new_branch))
        return json(422, { message: 'branch already exists' });
      const sha = nextSha();
      this.repos.get(`${org}/${slug}`)!.set(target, { head: sha, files });
      this.commits.push({ sha, branch: target, message: body.message, author: body.author, files });
      return json(201, { commit: { sha } });
    }
    if (
      (m = path.match(
        /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)(\/permission)?$/
      ))
    ) {
      const key = `${m[1]}/${m[2]}/${decodeURIComponent(m[3])}`;
      if (m[4]) return json(200, { permission: this.collaborators.get(key) ?? 'none' });
      if (method === 'PUT') {
        this.collaborators.set(key, body.permission);
        return json(204);
      }
      if (method === 'DELETE') {
        this.collaborators.delete(key);
        return json(204);
      }
    }
    if ((m = path.match(/^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/))) {
      for (const branches of this.repos.values())
        for (const b of branches.values())
          for (const c of Object.values(b.files))
            if (blob(c) === m[3])
              return json(200, { content: Buffer.from(c).toString('base64'), encoding: 'base64' });
      return json(404, {});
    }
    return json(500, { message: `fake git host: unhandled ${method} ${path}` });
  }
}

let git: FakeGit;

// ---------------------------------------------------------------------------
// The table, behind the db mock's raw SQL
// ---------------------------------------------------------------------------

type Row = {
  slug: string;
  ownerUserId: number;
  appBlockId: string | null;
  origin: string;
  forkedFromAppBlockId: string | null;
  forkedFromCommitSha: string | null;
  assistantTree: Record<string, string> | null;
  lastAssistantCommitSha: string | null;
  lastAssistantBranch: string | null;
};
let table: Map<string, Row> | null; // null = the migration is not applied
let tableWrites = 0;
const missingTable = () =>
  Object.assign(new Error('relation "app_source_repos" does not exist'), { code: '42P01' });

function sqlOf(strings: TemplateStringsArray) {
  return strings.join('?').replace(/\s+/g, ' ');
}

// Blocks, publish requests, seats and fork lineage the access checks and the backfill read.
let blocks: Array<{ id: string; blockId: string; ownerUserId: number }>;
let requests: Array<{
  appBlockId: string;
  submittedByUserId: number;
  status: string;
  slug: string;
}>;
let seats: Array<{ appBlockId: string; userId: number }>;
let forkLineage: Array<{ id: string; parentAppBlockId: string; parentCommitSha: string }>;
let approved: Record<string, { forgejoCommitSha: string; version: string }>;

const m = vi.hoisted(() => ({ reconstruct: vi.fn() }));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  reconstructBundleFromForgejo: m.reconstruct,
}));
// The block edit gate: owner or an accepted seat (the real one is pinned in app-access tests).
vi.mock('~/server/services/blocks/app-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAccessService>()),
  assertAppEditAccess: async (args: {
    appBlockId: string;
    ownerUserId: number | null | undefined;
    userId: number;
  }) => {
    if (typeof args.ownerUserId === 'number' && args.ownerUserId === args.userId) return;
    if (seats.some((s) => s.appBlockId === args.appBlockId && s.userId === args.userId)) return;
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the app owner' });
  },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

const svc = await import('~/server/services/blocks/app-source-repo.service');
const { ASSISTANT_BRANCH, ASSISTANT_AUTHOR, PLATFORM_AUTHOR } = await import(
  '~/server/services/blocks/app-source-repo.plan'
);
const SRC = 'civitai-apps-src';

function installDb() {
  const blockShape = (b: (typeof blocks)[number]) => ({
    id: b.id,
    blockId: b.blockId,
    app: { userId: b.ownerUserId },
  });
  dbMock.dbRead.appBlock.findFirst.mockImplementation(async (a: { where: { blockId: string } }) => {
    const b = blocks.find((x) => x.blockId === a.where.blockId);
    return b ? blockShape(b) : null;
  });
  dbMock.dbRead.appBlock.findUnique.mockImplementation(async (a: { where: { id: string } }) => {
    const b = blocks.find((x) => x.id === a.where.id);
    return b ? blockShape(b) : null;
  });
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockImplementation(
    async (a: {
      where: {
        appBlockId?: string;
        slug?: string;
        status?: string;
        submittedByUserId?: number | { not: number };
      };
    }) => {
      const w = a.where;
      if (w.status === 'approved' && w.appBlockId) {
        const hit = approved[w.appBlockId];
        return hit ? { ...hit } : null;
      }
      const r = requests.find(
        (x) =>
          (w.appBlockId === undefined || x.appBlockId === w.appBlockId) &&
          (w.slug === undefined || x.slug === w.slug) &&
          (w.status === undefined || x.status === w.status) &&
          (w.submittedByUserId === undefined ||
            (typeof w.submittedByUserId === 'number'
              ? x.submittedByUserId === w.submittedByUserId
              : x.submittedByUserId !== w.submittedByUserId.not))
      );
      return r ? { id: 'pr_x' } : null;
    }
  );
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = sqlOf(strings);
    if (sql.includes('FROM "app_source_repos" WHERE "slug" =')) {
      if (!table) throw missingTable();
      const row = table.get(values[0] as string);
      return row ? [structuredClone(row)] : [];
    }
    if (sql.includes('FROM "app_source_repos" sr')) {
      if (!table) throw missingTable();
      const userId = values[0] as number;
      return [...table.values()]
        .filter((r) => {
          const b = blocks.find((x) => x.id === r.appBlockId);
          return (
            (!r.appBlockId && r.ownerUserId === userId) ||
            b?.ownerUserId === userId ||
            seats.some((s) => s.appBlockId === r.appBlockId && s.userId === userId)
          );
        })
        .map((r) => ({ slug: r.slug }));
    }
    if (sql.includes('FROM "app_blocks" ab')) {
      return forkLineage.map((f) => {
        const b = blocks.find((x) => x.id === f.id)!;
        const parent = blocks.find((x) => x.id === f.parentAppBlockId);
        return {
          id: b.id,
          slug: b.blockId,
          ownerUserId: b.ownerUserId,
          parentAppBlockId: f.parentAppBlockId,
          parentCommitSha: f.parentCommitSha,
          parentSlug: parent?.blockId ?? null,
        };
      });
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const execute = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = sqlOf(strings);
    if (!table) throw missingTable();
    tableWrites += 1;
    if (sql.startsWith('INSERT INTO "app_source_repos"')) {
      const [slug, ownerUserId, appBlockId, origin, fA, fC, tree, sha] = values as [
        string,
        number,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string | null
      ];
      if (table.has(slug)) return 0;
      table.set(slug, {
        slug,
        ownerUserId,
        appBlockId,
        origin,
        forkedFromAppBlockId: fA,
        forkedFromCommitSha: fC,
        assistantTree: JSON.parse(tree),
        lastAssistantCommitSha: sha,
        lastAssistantBranch: sha ? 'main' : null,
      });
      return 1;
    }
    if (sql.includes('SET "assistant_tree"')) {
      const [tree, sha, branch, slug] = values as [string, string, string, string];
      const row = table.get(slug)!;
      Object.assign(row, {
        assistantTree: JSON.parse(tree),
        lastAssistantCommitSha: sha,
        lastAssistantBranch: branch,
      });
      return 1;
    }
    if (sql.includes('SET "app_block_id"')) {
      const [appBlockId, slug] = values as [string, string];
      const row = table.get(slug);
      if (!row || row.appBlockId) return 0;
      row.appBlockId = appBlockId;
      return 1;
    }
    throw new Error(`unexpected write: ${sql}`);
  };
  dbMock.dbWrite.$queryRaw.mockImplementation(query);
  dbMock.dbRead.$queryRaw.mockImplementation(query);
  dbMock.dbWrite.$executeRaw.mockImplementation(execute);
}

const redisStore = new Map<string, string>();
function installRedis() {
  redisStore.clear();
  redisMock.sysRedis.get.mockImplementation(async (k: string) => redisStore.get(k) ?? null);
  redisMock.sysRedis.set.mockImplementation(async (k: string, v: string, o?: { NX?: boolean }) => {
    if (o?.NX && redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  });
  redisMock.sysRedis.del.mockImplementation(async (k: string) => (redisStore.delete(k) ? 1 : 0));
  (redisMock.sysRedis as unknown as { scanIterator: unknown }).scanIterator = vi.fn(
    async function* () {
      yield [] as string[];
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  commitSeq = 0;
  git = new FakeGit();
  table = new Map();
  tableWrites = 0;
  blocks = [];
  requests = [];
  seats = [];
  forkLineage = [];
  approved = {};
  installDb();
  installRedis();
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

const buf = (s: string) => Buffer.from(s, 'utf8');
const files = (rec: Record<string, string>) =>
  Object.entries(rec).map(([path, c]) => ({ path, content: buf(c) }));

const OWNER = 7101;
const OTHER = 7102;
const EDITOR = 7103;
const SLUG = 'pixel-garden-fork-1a2b';
const PARENT_SHA = 'c0ffee'.repeat(6) + 'beef';

// ---------------------------------------------------------------------------

describe('fork start → the fork’s source repo', () => {
  it('is created private-org, seeded with the files, Forked-From-* from the lineage given', async () => {
    const result = await svc.createForkSourceRepo({
      forkSlug: SLUG,
      userId: OWNER,
      files: files({ 'block.manifest.json': '{"blockId":"x"}', 'src/a.ts': 'a' }),
      lineage: {
        parentSlug: 'pixel-garden',
        parentCommitSha: PARENT_SHA,
        parentAppBlockId: 'ab_p',
      },
    });
    expect(result.kind).toBe('created');
    expect(git.orgs.has(SRC)).toBe(true);
    const main = git.branch(SRC, SLUG)!;
    // README from the repo's auto-init is gone: the branch holds exactly the seed.
    expect(main.files).toEqual({ 'block.manifest.json': '{"blockId":"x"}', 'src/a.ts': 'a' });
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0].message).toBe(
      `Fork of pixel-garden\n\nForked-From-App: pixel-garden\nForked-From-Commit: ${PARENT_SHA}`
    );
    expect(git.commits[0].author).toEqual(PLATFORM_AUTHOR);
    expect(table!.get(SLUG)).toMatchObject({
      ownerUserId: OWNER,
      origin: 'fork',
      forkedFromAppBlockId: 'ab_p',
      forkedFromCommitSha: PARENT_SHA,
      lastAssistantCommitSha: git.commits[0].sha,
    });
    // No webhook is attached to a source repo (nothing there may build or file a request).
    expect(git.calls.some((c) => c.path.endsWith('/hooks'))).toBe(false);
  });

  it('never throws: a git-host outage reads as `failed`, and records nothing', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }));
    const result = await svc.createForkSourceRepo({
      forkSlug: SLUG,
      userId: OWNER,
      files: files({ a: '1' }),
      lineage: {
        parentSlug: 'pixel-garden',
        parentCommitSha: PARENT_SHA,
        parentAppBlockId: 'ab_p',
      },
    });
    expect(result).toEqual({ kind: 'failed' });
    expect(table!.size).toBe(0);
  });

  it('a second start of the same slug writes nothing', async () => {
    const args = {
      forkSlug: SLUG,
      userId: OWNER,
      files: files({ a: '1' }),
      lineage: {
        parentSlug: 'pixel-garden',
        parentCommitSha: PARENT_SHA,
        parentAppBlockId: 'ab_p',
      },
    };
    await svc.createForkSourceRepo(args);
    const writes = git.writes.length;
    const rows = tableWrites;
    expect((await svc.createForkSourceRepo(args)).kind).toBe('exists');
    expect(git.writes.length).toBe(writes);
    expect(tableWrites).toBe(rows);
  });
});

describe('App Assistant saves', () => {
  it('the first save creates the repo and lands one commit, by the assistant, for the user', async () => {
    const result = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'block.manifest.json': '{}', 'src/App.tsx': 'v1' }),
    });
    expect(result).toMatchObject({ kind: 'committed', branch: 'main', conflict: false });
    expect(git.branch(SRC, 'my-app')!.files).toEqual({
      'block.manifest.json': '{}',
      'src/App.tsx': 'v1',
    });
    const last = git.commits.at(-1)!;
    expect(last.author).toEqual(ASSISTANT_AUTHOR);
    expect(last.message).toBe(
      'App Assistant: add 2 files, delete README.md\n\n' +
        'Assisted-by: Civitai App Assistant\n' +
        `On-behalf-of: dev-${OWNER}`
    );
    expect(table!.get('my-app')).toMatchObject({ origin: 'assistant', ownerUserId: OWNER });
  });

  it('a save that changes nothing writes no commit', async () => {
    const f = files({ 'block.manifest.json': '{}' });
    await svc.saveAssistantFiles({ slug: 'my-app', userId: OWNER, files: f });
    const n = git.commits.length;
    expect(await svc.saveAssistantFiles({ slug: 'my-app', userId: OWNER, files: f })).toEqual({
      kind: 'unchanged',
    });
    expect(git.commits.length).toBe(n);
  });

  it('a later save commits only what the assistant changed', async () => {
    await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a1', 'b.ts': 'b1' }),
    });
    await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
    });
    expect(git.commits.at(-1)!.message.split('\n')[0]).toBe('App Assistant: update a.ts');
  });
});

describe('🔴 a developer push and an assistant save — neither side is lost', () => {
  const start = async () => {
    await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a1', 'b.ts': 'b1' }),
    });
  };

  it('the developer changed a file the save does NOT touch: the save lands on main, their change stays', async () => {
    await start();
    git.devPush(SRC, 'my-app', { 'b.ts': 'b-dev', 'dev.ts': 'mine' });
    const result = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
    });
    expect(result).toMatchObject({ kind: 'committed', branch: 'main', conflict: false });
    expect(git.branch(SRC, 'my-app')!.files).toEqual({
      'a.ts': 'a2',
      'b.ts': 'b-dev',
      'dev.ts': 'mine',
    });
  });

  it('the developer changed the SAME file: main keeps theirs, the save goes to the assistant branch whole', async () => {
    await start();
    git.devPush(SRC, 'my-app', { 'a.ts': 'a-dev' });
    const result = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
    });
    expect(result).toMatchObject({ kind: 'committed', branch: ASSISTANT_BRANCH, conflict: true });
    expect(git.branch(SRC, 'my-app')!.files).toEqual({ 'a.ts': 'a-dev', 'b.ts': 'b1' });
    expect(git.branch(SRC, 'my-app', ASSISTANT_BRANCH)!.files).toEqual({
      'a.ts': 'a2',
      'b.ts': 'b1',
    });
    expect(table!.get('my-app')!.lastAssistantBranch).toBe(ASSISTANT_BRANCH);
  });

  it('the developer DELETED a file the save changes: still not overwritten, the branch carries it', async () => {
    await start();
    git.devPush(SRC, 'my-app', { 'a.ts': null });
    const result = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
    });
    expect(result).toMatchObject({ branch: ASSISTANT_BRANCH, conflict: true });
    expect(git.branch(SRC, 'my-app')!.files).toEqual({ 'b.ts': 'b1' });
  });

  it('the developer CREATED a file the assistant also creates: the branch, not an overwrite', async () => {
    await start();
    git.devPush(SRC, 'my-app', { 'c.ts': 'c-dev' });
    const result = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a1', 'b.ts': 'b1', 'c.ts': 'c-assistant' }),
    });
    expect(result).toMatchObject({ branch: ASSISTANT_BRANCH, conflict: true });
    expect(git.branch(SRC, 'my-app')!.files['c.ts']).toBe('c-dev');
  });

  it('a second conflicting save goes on top of the assistant branch (one linear history)', async () => {
    await start();
    git.devPush(SRC, 'my-app', { 'a.ts': 'a-dev' });
    await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
    });
    const first = git.branch(SRC, 'my-app', ASSISTANT_BRANCH)!.head;
    await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a3', 'b.ts': 'b1' }),
    });
    const second = git.commits.at(-1)!;
    expect(second.branch).toBe(ASSISTANT_BRANCH);
    expect(second.sha).not.toBe(first);
    expect(git.branch(SRC, 'my-app')!.files['a.ts']).toBe('a-dev');
  });

  it('after a save went to the branch, a later NON-conflicting save follows it there, until main catches up', async () => {
    await start();
    git.devPush(SRC, 'my-app', { 'a.ts': 'a-dev' });
    // Save 1 changes a.ts (conflict) and adds h.ts: it goes to the branch.
    await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1', 'h.ts': 'h1' }),
    });
    // Save 2 changes only g.ts, which main would accept: it still goes to the branch, so the
    // branch is the assistant's whole history and main never gets g.ts without h.ts.
    const second = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b1', 'h.ts': 'h1', 'g.ts': 'g1' }),
    });
    expect(second).toMatchObject({ branch: ASSISTANT_BRANCH, conflict: true });
    expect(git.branch(SRC, 'my-app')!.files).toEqual({ 'a.ts': 'a-dev', 'b.ts': 'b1' });
    expect(git.branch(SRC, 'my-app', ASSISTANT_BRANCH)!.files).toEqual({
      'a.ts': 'a2',
      'b.ts': 'b1',
      'h.ts': 'h1',
      'g.ts': 'g1',
    });
    // The developer merges the branch: main now holds the assistant's last tree.
    git.devPush(SRC, 'my-app', { 'a.ts': 'a2', 'h.ts': 'h1', 'g.ts': 'g1' });
    const third = await svc.saveAssistantFiles({
      slug: 'my-app',
      userId: OWNER,
      files: files({ 'a.ts': 'a2', 'b.ts': 'b2', 'h.ts': 'h1', 'g.ts': 'g1' }),
    });
    expect(third).toMatchObject({ branch: 'main', conflict: false });
    expect(git.branch(SRC, 'my-app')!.files['b.ts']).toBe('b2');
  });

  it('two saves of one app at once: the second waits for the lock and does not conflict', async () => {
    await start();
    const [x, y] = await Promise.all([
      svc.saveAssistantFiles({
        slug: 'my-app',
        userId: OWNER,
        files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
      }),
      svc.saveAssistantFiles({
        slug: 'my-app',
        userId: OWNER,
        files: files({ 'a.ts': 'a2', 'b.ts': 'b1' }),
      }),
    ]);
    expect([x.kind, y.kind].sort()).toEqual(['committed', 'unchanged']);
    expect(git.branch(SRC, 'my-app', ASSISTANT_BRANCH)).toBeNull();
  });
});

describe('access — the build repo’s parity', () => {
  const seed = async (slug = 'my-app', owner = OWNER) =>
    svc.saveAssistantFiles({ slug, userId: owner, files: files({ a: '1' }) });

  it('unbound: the repo’s owner only', async () => {
    await seed();
    expect(await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OWNER })).toMatchObject({
      ok: true,
      role: 'owner',
    });
    expect(await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OTHER })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('bound to the owner’s block: an ACCEPTED collaborator too; a stranger never', async () => {
    await seed();
    blocks.push({ id: 'ab_1', blockId: 'my-app', ownerUserId: OWNER });
    seats.push({ appBlockId: 'ab_1', userId: EDITOR });
    expect(await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: EDITOR })).toMatchObject({
      ok: true,
      role: 'editor',
    });
    expect(table!.get('my-app')!.appBlockId).toBe('ab_1');
    expect((await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OTHER })).ok).toBe(false);
  });

  it('🔴 an ownership transfer moves access: the old owner (the repo’s creator) is refused', async () => {
    await seed();
    // The block was the creator's (they filed its versions) and now belongs to OTHER.
    blocks.push({ id: 'ab_1', blockId: 'my-app', ownerUserId: OTHER });
    requests.push({
      appBlockId: 'ab_1',
      submittedByUserId: OWNER,
      status: 'approved',
      slug: 'my-app',
    });
    expect((await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OTHER })).ok).toBe(true);
    expect(await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OWNER })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('🔴 a squatted slug: the block’s owner never reaches a repo its creator never shared', async () => {
    await seed();
    blocks.push({ id: 'ab_9', blockId: 'my-app', ownerUserId: OTHER });
    requests.push({
      appBlockId: 'ab_9',
      submittedByUserId: OTHER,
      status: 'approved',
      slug: 'my-app',
    });
    expect((await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OTHER })).ok).toBe(false);
    expect((await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OWNER })).ok).toBe(true);
    expect(table!.get('my-app')!.appBlockId).toBeNull();
  });

  it('a repo cannot be created for a slug whose block someone else owns, nor one another account has pending', async () => {
    blocks.push({ id: 'ab_9', blockId: 'their-app', ownerUserId: OTHER });
    expect(await seed('their-app', OWNER)).toEqual({ kind: 'refused' });
    requests.push({
      appBlockId: 'none',
      submittedByUserId: OTHER,
      status: 'pending',
      slug: 'queued-app',
    });
    expect(await seed('queued-app', OWNER)).toEqual({ kind: 'refused' });
    expect(git.repos.size).toBe(0);
  });

  it('a save by someone who may not use the repo is refused and writes nothing', async () => {
    await seed();
    const writes = git.writes.length;
    expect(
      await svc.saveAssistantFiles({ slug: 'my-app', userId: OTHER, files: files({ a: '2' }) })
    ).toEqual({ kind: 'refused' });
    expect(git.writes.length).toBe(writes);
  });

  it('pull grants `write` on the source repo and returns its token-less URL', async () => {
    await seed();
    expect(
      await svc.grantSourceRepoForPull({
        slug: 'my-app',
        userId: OWNER,
        forgejoUsername: `dev-${OWNER}`,
      })
    ).toEqual({ sourceHttpUrl: `${HOST}/${SRC}/my-app.git` });
    expect(git.collaborators.get(`${SRC}/my-app/dev-${OWNER}`)).toBe('write');
    expect(
      await svc.grantSourceRepoForPull({
        slug: 'my-app',
        userId: OTHER,
        forgejoUsername: `dev-${OTHER}`,
      })
    ).toBeNull();
    expect(git.collaborators.has(`${SRC}/my-app/dev-${OTHER}`)).toBe(false);
  });

  it('a ban removes the user’s rows on every repo they own or hold a seat on — and only theirs', async () => {
    await seed('mine-a');
    await seed('mine-b');
    await seed('theirs', OTHER);
    blocks.push({ id: 'ab_t', blockId: 'theirs', ownerUserId: OTHER });
    await svc.resolveSourceRepoAccess({ slug: 'theirs', userId: OTHER }); // binds
    seats.push({ appBlockId: 'ab_t', userId: OWNER });
    for (const s of ['mine-a', 'mine-b', 'theirs'])
      git.collaborators.set(`${SRC}/${s}/dev-${OWNER}`, 'write');
    git.collaborators.set(`${SRC}/theirs/dev-${OTHER}`, 'write');
    expect(await svc.revokeSourceRepoAccessForUser(OWNER)).toBe(3);
    expect([...git.collaborators.keys()]).toEqual([`${SRC}/theirs/dev-${OTHER}`]);
  });
});

describe('the migration not applied → the feature is off', () => {
  it('saves, access and pull do nothing and call no git host', async () => {
    table = null;
    expect(
      await svc.saveAssistantFiles({ slug: 'my-app', userId: OWNER, files: files({ a: '1' }) })
    ).toEqual({ kind: 'unavailable' });
    expect(await svc.resolveSourceRepoAccess({ slug: 'my-app', userId: OWNER })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(
      await svc.grantSourceRepoForPull({ slug: 'my-app', userId: OWNER, forgejoUsername: 'dev-1' })
    ).toBeNull();
    expect(await svc.revokeSourceRepoAccessForUser(OWNER)).toBe(0);
    expect(git.calls).toEqual([]);
  });
});

describe('backfill', () => {
  async function bundle(rec: Record<string, string>) {
    const zip = new JSZip();
    for (const [p, c] of Object.entries(rec)) zip.file(p, c);
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }
  const APPROVED = 'ab'.repeat(20);

  beforeEach(() => {
    blocks.push(
      { id: 'ab_parent', blockId: 'pixel-garden', ownerUserId: OTHER },
      { id: 'ab_fork', blockId: 'pixel-garden-fork-9f9f', ownerUserId: OWNER }
    );
    forkLineage.push({ id: 'ab_fork', parentAppBlockId: 'ab_parent', parentCommitSha: PARENT_SHA });
    approved.ab_fork = { forgejoCommitSha: APPROVED, version: '0.3.0' };
    m.reconstruct.mockImplementation(async () =>
      bundle({ 'block.manifest.json': '{"blockId":"pixel-garden-fork-9f9f"}', '.env': 'SECRET=1' })
    );
  });

  it('dry run: lists what it would create, and writes nothing at all', async () => {
    const result = await svc.backfillAppSourceRepos({ dryRun: true });
    expect(result.created).toEqual([
      {
        slug: 'pixel-garden-fork-9f9f',
        kind: 'approved-fork',
        from: `pixel-garden-fork-9f9f@${APPROVED}`,
      },
    ]);
    expect(git.calls).toEqual([]);
    expect(tableWrites).toBe(0);
  });

  it('seeds an approved fork from its latest approved snapshot, with its lineage', async () => {
    const result = await svc.backfillAppSourceRepos();
    expect(result.created.map((c) => c.slug)).toEqual(['pixel-garden-fork-9f9f']);
    expect(m.reconstruct).toHaveBeenCalledWith('pixel-garden-fork-9f9f', APPROVED);
    expect(git.branch(SRC, 'pixel-garden-fork-9f9f')!.files).toEqual({
      'block.manifest.json': '{"blockId":"pixel-garden-fork-9f9f"}',
    });
    expect(git.commits[0].message).toBe(
      `Import v0.3.0\n\nApproved-Commit: ${APPROVED}\n` +
        `Forked-From-App: pixel-garden\nForked-From-Commit: ${PARENT_SHA}`
    );
  });

  it('🔴 a second run makes ZERO writes (git host and table)', async () => {
    await svc.backfillAppSourceRepos();
    const gitWrites = git.writes.length;
    const rows = tableWrites;
    const second = await svc.backfillAppSourceRepos();
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual(['pixel-garden-fork-9f9f']);
    expect(git.writes.length).toBe(gitWrites);
    expect(tableWrites).toBe(rows);
  });

  it('the table missing: nothing read or written', async () => {
    table = null;
    expect(await svc.backfillAppSourceRepos()).toMatchObject({ unavailable: true, candidates: 0 });
    expect(git.calls).toEqual([]);
  });
});

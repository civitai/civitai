import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the W1-new forgejo.service helpers: listRepoTree, getBlobContent,
 * commitFiles. The pre-W1 functions (createRepoFromTemplate, ensurePushWebhook,
 * getRawFile, setCommitStatus, addCollaborator) are out of scope here but the
 * mock infra in this file can be reused if they need coverage later.
 *
 * Strategy: mock global.fetch and assert on the URLs + bodies that the service
 * sends to Forgejo. No real HTTP; no real Forgejo.
 */

vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok-test',
    FORGEJO_WEBHOOK_SECRET: 'sec-test',
    APPS_DOMAIN: 'civit.ai',
    // Distinct values so the timeout-routing assertions are unambiguous about
    // which ceiling a given call used.
    FORGEJO_API_TIMEOUT_MS: 15000,
    FORGEJO_COMMIT_TIMEOUT_MS: 120000,
  },
}));

type FetchCall = { url: string; init?: RequestInit };

function makeFetchMock() {
  const calls: FetchCall[] = [];
  const responses: Array<Response | Promise<Response>> = [];
  const fn = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (responses.length === 0) {
      throw new Error(`fetch mock: no queued response for ${String(url)}`);
    }
    return responses.shift()!;
  });
  return {
    fn,
    calls,
    enqueue(body: unknown, status = 200) {
      const text = body == null ? '' : JSON.stringify(body);
      responses.push(
        new Response(text, {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    },
    enqueueRaw(response: Response) {
      responses.push(response);
    },
  };
}

let fm: ReturnType<typeof makeFetchMock>;

beforeEach(() => {
  fm = makeFetchMock();
  vi.stubGlobal('fetch', fm.fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listRepoTree', () => {
  it('walks the default branch tree and returns a path → sha map of blobs only', async () => {
    const { listRepoTree } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({
      tree: [
        { path: 'block.manifest.json', type: 'blob', sha: 'blob1' },
        { path: 'src/', type: 'tree', sha: 'tree1' },
        { path: 'src/index.tsx', type: 'blob', sha: 'blob2' },
      ],
      truncated: false,
    });

    const result = await listRepoTree('hello', 'main');
    expect(result.size).toBe(2);
    expect(result.get('block.manifest.json')).toBe('blob1');
    expect(result.get('src/index.tsx')).toBe('blob2');
    // Trees (directories) are excluded.
    expect(result.has('src/')).toBe(false);

    // Branch lookup URL.
    expect(fm.calls[0].url).toBe(
      'https://forgejo.example/api/v1/repos/civitai-apps/hello/branches/main'
    );
    // Recursive=true + per_page=1000.
    expect(fm.calls[1].url).toBe(
      'https://forgejo.example/api/v1/repos/civitai-apps/hello/git/trees/commit_sha?recursive=true&per_page=1000'
    );
    // Auth header carried.
    expect((fm.calls[0].init?.headers as Record<string, string>)['Authorization']).toBe(
      'token tok-test'
    );
  });

  it('throws when the tree is truncated (>1000 entries; no pagination yet)', async () => {
    const { listRepoTree } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({
      tree: [{ path: 'a', type: 'blob', sha: 'b1' }],
      truncated: true,
    });

    await expect(listRepoTree('hello', 'main')).rejects.toThrow(/truncated/);
  });

  it('URL-encodes the branch name', async () => {
    const { listRepoTree } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({ tree: [], truncated: false });
    await listRepoTree('hello', 'feature/with/slashes');
    expect(fm.calls[0].url).toContain('/branches/feature%2Fwith%2Fslashes');
  });

  it('throws a readable error when the branch lookup 404s', async () => {
    const { listRepoTree } = await import('../forgejo.service');
    fm.enqueue({ message: 'branch not found' }, 404);
    await expect(listRepoTree('hello', 'main')).rejects.toThrow(/404/);
  });
});

describe('getBlobContent', () => {
  it('decodes base64 blob content into a Buffer', async () => {
    const { getBlobContent } = await import('../forgejo.service');
    const payload = Buffer.from('hello world', 'utf8');
    fm.enqueue({ content: payload.toString('base64'), encoding: 'base64' });

    const result = await getBlobContent('hello', 'blob_sha_1');
    expect(result.toString('utf8')).toBe('hello world');
    expect(fm.calls[0].url).toBe(
      'https://forgejo.example/api/v1/repos/civitai-apps/hello/git/blobs/blob_sha_1'
    );
  });

  it('throws on unexpected encoding (we only handle base64)', async () => {
    const { getBlobContent } = await import('../forgejo.service');
    fm.enqueue({ content: 'plaintext', encoding: 'utf-8' });
    await expect(getBlobContent('hello', 'blob_sha_1')).rejects.toThrow(
      /unexpected encoding utf-8/
    );
  });
});

describe('commitFiles', () => {
  it('sends a single multi-file batch with create / update / delete', async () => {
    const { commitFiles } = await import('../forgejo.service');
    // listRepoTree: branch + tree
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({
      tree: [
        { path: 'oldfile.txt', type: 'blob', sha: 'old_blob_sha' },
        { path: 'index.html', type: 'blob', sha: 'index_old_blob_sha' },
      ],
      truncated: false,
    });
    // commit POST
    fm.enqueue({ commit: { sha: 'new_commit_sha' } });

    const result = await commitFiles({
      slug: 'hello',
      files: [
        { path: 'block.manifest.json', content: Buffer.from('{"blockId":"hello"}') },
        { path: 'index.html', content: Buffer.from('<doc>') }, // update
      ],
      message: 'Approved publish request pubreq_x — hello v0.1.0',
      replaceAllFiles: true,
    });
    expect(result.sha).toBe('new_commit_sha');

    // Inspect the POST body.
    const postCall = fm.calls.find(
      (c) => c.url === 'https://forgejo.example/api/v1/repos/civitai-apps/hello/contents'
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall!.init!.body as string);
    expect(body.message).toMatch(/Approved publish request/);
    expect(body.branch).toBe('main');

    // Operations: create new manifest, update index.html, delete oldfile.txt.
    const ops = body.files as Array<{ operation: string; path: string; sha?: string }>;
    expect(ops).toContainEqual(
      expect.objectContaining({ operation: 'create', path: 'block.manifest.json' })
    );
    expect(ops).toContainEqual(
      expect.objectContaining({
        operation: 'update',
        path: 'index.html',
        sha: 'index_old_blob_sha',
      })
    );
    expect(ops).toContainEqual({
      operation: 'delete',
      path: 'oldfile.txt',
      sha: 'old_blob_sha',
    });
  });

  it('skips delete operations when replaceAllFiles is false', async () => {
    const { commitFiles } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({
      tree: [{ path: 'oldfile.txt', type: 'blob', sha: 'old_blob_sha' }],
      truncated: false,
    });
    fm.enqueue({ commit: { sha: 'new_commit_sha' } });

    await commitFiles({
      slug: 'hello',
      files: [{ path: 'newfile.txt', content: Buffer.from('hi') }],
      message: 'msg',
      replaceAllFiles: false,
    });
    const postCall = fm.calls.find((c) =>
      c.url.endsWith('/civitai-apps/hello/contents')
    );
    const body = JSON.parse(postCall!.init!.body as string);
    const deletes = body.files.filter((o: { operation: string }) => o.operation === 'delete');
    expect(deletes).toEqual([]);
  });

  it('base64-encodes file contents', async () => {
    const { commitFiles } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({ tree: [], truncated: false });
    fm.enqueue({ commit: { sha: 'new_commit_sha' } });

    const raw = Buffer.from('binary-content', 'utf8');
    await commitFiles({
      slug: 'hello',
      files: [{ path: 'data.bin', content: raw }],
      message: 'msg',
    });
    const body = JSON.parse(fm.calls[2].init!.body as string);
    const op = body.files[0];
    expect(op.operation).toBe('create');
    expect(op.content).toBe(raw.toString('base64'));
  });

  it('treats an identical-content bundle as a no-op (returns current HEAD)', async () => {
    const { commitFiles } = await import('../forgejo.service');
    // listRepoTree returns same files (with same sha as the new ones would
    // produce if pre-hashed). In practice we can't predict the blob sha of
    // unchanged content here, but if `files` is empty the operations array
    // is empty and the service short-circuits.
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({ tree: [], truncated: false });
    // Branch re-fetch for the head sha (because operations.length === 0)
    fm.enqueue({ commit: { id: 'commit_sha_head' } });

    const result = await commitFiles({
      slug: 'hello',
      files: [],
      message: 'msg',
    });
    expect(result.sha).toBe('commit_sha_head');

    // No POST to /contents.
    expect(fm.calls.find((c) => c.url.endsWith('/contents'))).toBeUndefined();
  });

  // H-3 lock-in — when Forgejo returns 404 for the multi-file commit endpoint
  // (older versions don't have it), commitFiles surfaces a Forgejo-prefixed
  // error that the router translates to BAD_REQUEST.
  it('REGRESSION (H-3): Forgejo 404 on /contents bubbles up readably', async () => {
    const { commitFiles } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({ tree: [], truncated: false });
    fm.enqueue({ message: 'Not Found' }, 404);

    await expect(
      commitFiles({
        slug: 'hello',
        files: [{ path: 'a.txt', content: Buffer.from('hi') }],
        message: 'msg',
      })
    ).rejects.toThrow(/Forgejo 404/);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (git-push self-service) — per-user Forgejo identity provisioning.
// ---------------------------------------------------------------------------

describe('createForgejoUser', () => {
  it('POSTs a restricted/private user via the admin API and returns the password (fresh create)', async () => {
    const { createForgejoUser } = await import('../forgejo.service');
    fm.enqueue({ id: 42, login: 'dev-7', username: 'dev-7' });

    const res = await createForgejoUser({ username: 'dev-7', email: 'dev-7@apps.civitai.invalid' });
    expect(res.created).toBe(true);
    expect(res.user.id).toBe(42);
    expect(typeof res.password).toBe('string');
    expect((res.password as string).length).toBeGreaterThanOrEqual(24);

    // Admin endpoint + admin token + restricted/private flags.
    expect(fm.calls[0].url).toBe('https://forgejo.example/api/v1/admin/users');
    expect((fm.calls[0].init?.headers as Record<string, string>)['Authorization']).toBe(
      'token tok-test'
    );
    const body = JSON.parse(fm.calls[0].init!.body as string);
    expect(body.username).toBe('dev-7');
    expect(body.email).toBe('dev-7@apps.civitai.invalid');
    expect(body.restricted).toBe(true);
    expect(body.visibility).toBe('private');
    expect(body.must_change_password).toBe(false);
    expect(typeof body.password).toBe('string');
  });

  it('is idempotent on 422 (already exists) — falls back to getForgejoUser, returns null password', async () => {
    const { createForgejoUser } = await import('../forgejo.service');
    fm.enqueue({ message: 'user already exists' }, 422); // POST /admin/users
    fm.enqueue({ id: 9, username: 'dev-7' }); // GET /users/dev-7

    const res = await createForgejoUser({ username: 'dev-7', email: 'dev-7@apps.civitai.invalid' });
    expect(res.created).toBe(false);
    expect(res.password).toBeNull();
    expect(res.user.id).toBe(9);

    // Second call is the GET fallback.
    expect(fm.calls[1].url).toBe('https://forgejo.example/api/v1/users/dev-7');
  });
});

describe('getForgejoUser', () => {
  it('GETs the user by username with admin auth', async () => {
    const { getForgejoUser } = await import('../forgejo.service');
    fm.enqueue({ id: 5, username: 'dev-12' });

    const user = await getForgejoUser('dev-12');
    expect(user.id).toBe(5);
    expect(fm.calls[0].url).toBe('https://forgejo.example/api/v1/users/dev-12');
    expect((fm.calls[0].init?.headers as Record<string, string>)['Authorization']).toBe(
      'token tok-test'
    );
  });
});

describe('mintForgejoUserToken', () => {
  it('authenticates as the user via HTTP Basic (NOT the admin token) and returns the sha1', async () => {
    const { mintForgejoUserToken } = await import('../forgejo.service');
    fm.enqueue({ id: 1, name: 'civitai-git-push', sha1: 'tok-sha1-abc' });

    const sha1 = await mintForgejoUserToken({
      username: 'dev-7',
      password: 'pw-1234567890abcdef',
      name: 'civitai-git-push',
      scopes: ['write:repository'],
    });
    expect(sha1).toBe('tok-sha1-abc');

    expect(fm.calls[0].url).toBe('https://forgejo.example/api/v1/users/dev-7/tokens');
    const auth = (fm.calls[0].init?.headers as Record<string, string>)['Authorization'];
    const expected = `Basic ${Buffer.from('dev-7:pw-1234567890abcdef').toString('base64')}`;
    expect(auth).toBe(expected);
    // Crucially NOT the admin token.
    expect(auth).not.toContain('tok-test');

    const body = JSON.parse(fm.calls[0].init!.body as string);
    expect(body.name).toBe('civitai-git-push');
    expect(body.scopes).toEqual(['write:repository']);
  });

  it('throws when Forgejo returns no sha1', async () => {
    const { mintForgejoUserToken } = await import('../forgejo.service');
    fm.enqueue({ id: 1, name: 'x' }); // missing sha1
    await expect(
      mintForgejoUserToken({ username: 'dev-7', password: 'pw', name: 'x', scopes: [] })
    ).rejects.toThrow(/no sha1/);
  });
});

// ---------------------------------------------------------------------------
// Timeout routing — the bug fix. The bundle COMMIT/PUSH path must use the
// generous FORGEJO_COMMIT_TIMEOUT_MS (120s) so a real app (gen-matrix = ~888
// files) doesn't abort at the old 15s ceiling ("The operation was aborted due
// to timeout"); the cheap metadata calls keep the small FORGEJO_API_TIMEOUT_MS
// (15s) so an in-cluster reachability problem still surfaces fast.
//
// Strategy: spy on AbortSignal.timeout to capture each call's timeout in order.
// Each fjFetch / raw fetch calls AbortSignal.timeout immediately before fetch,
// so the Nth captured timeout pairs with the Nth recorded fetch call.
// ---------------------------------------------------------------------------
describe('Forgejo client-side timeout routing', () => {
  let timeouts: number[];
  let realTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    timeouts = [];
    realTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      // Return a never-firing signal: the fetch mock resolves synchronously,
      // so the real timer would only leak. We just need to observe `ms`.
      return new AbortController().signal;
    });
  });

  afterEach(() => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(realTimeout);
    vi.restoreAllMocks();
  });

  it('commitFiles: the multi-file commit POST uses the 120s commit timeout; the tree/branch reads keep 15s', async () => {
    const { commitFiles } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } }); // listRepoTree: branch
    fm.enqueue({ tree: [], truncated: false }); // listRepoTree: tree
    fm.enqueue({ commit: { sha: 'new_commit_sha' } }); // contents POST

    await commitFiles({
      slug: 'gen-matrix',
      files: [{ path: 'a.txt', content: Buffer.from('hi') }],
      message: 'msg',
    });

    // Pair captured timeouts to fetch calls by index.
    const branchIdx = fm.calls.findIndex((c) => c.url.includes('/branches/'));
    const treeIdx = fm.calls.findIndex((c) => c.url.includes('/git/trees/'));
    const commitIdx = fm.calls.findIndex((c) => c.url.endsWith('/contents'));
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(treeIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThanOrEqual(0);

    // Cheap reads keep the small ceiling.
    expect(timeouts[branchIdx]).toBe(15000);
    expect(timeouts[treeIdx]).toBe(15000);
    // The slow commit/push gets the generous one.
    expect(timeouts[commitIdx]).toBe(120000);
  });

  it('ensureReviewRepo: the auto_init repo-create POST uses the 120s commit timeout; the org-create keeps 15s', async () => {
    const { ensureReviewRepo } = await import('../forgejo.service');
    fm.enqueue(null, 422); // POST /orgs (already exists)
    fm.enqueue(null, 201); // POST /orgs/<review>/repos (created)

    await ensureReviewRepo('gen-matrix');

    const orgIdx = fm.calls.findIndex((c) => c.url.endsWith('/api/v1/orgs'));
    const repoIdx = fm.calls.findIndex((c) =>
      c.url.endsWith('/orgs/civitai-apps-review/repos')
    );
    expect(orgIdx).toBeGreaterThanOrEqual(0);
    expect(repoIdx).toBeGreaterThanOrEqual(0);
    expect(timeouts[orgIdx]).toBe(15000);
    expect(timeouts[repoIdx]).toBe(120000);
  });

  it('createRepoFromTemplate: the repo-create POST uses the 120s commit timeout', async () => {
    const { createRepoFromTemplate } = await import('../forgejo.service');
    fm.enqueue({
      id: 1,
      name: 'gen-matrix',
      full_name: 'civitai-apps/gen-matrix',
      html_url: '',
      clone_url: '',
      ssh_url: '',
      default_branch: 'main',
    }); // generate POST

    await createRepoFromTemplate({ slug: 'gen-matrix', template: 'starter' });

    const genIdx = fm.calls.findIndex((c) => c.url.endsWith('/generate'));
    expect(genIdx).toBeGreaterThanOrEqual(0);
    expect(timeouts[genIdx]).toBe(120000);
  });

  it('cheap metadata calls (getRepo, addCollaborator, setCommitStatus) keep the 15s API timeout', async () => {
    const svc = await import('../forgejo.service');

    fm.enqueue({
      id: 1,
      name: 'gen-matrix',
      full_name: 'civitai-apps/gen-matrix',
      html_url: '',
      clone_url: '',
      ssh_url: '',
      default_branch: 'main',
    });
    await svc.getRepo('gen-matrix');
    expect(timeouts[timeouts.length - 1]).toBe(15000);

    // addCollaborator treats res.ok as success; a 200 avoids the JS Response
    // 204-must-be-null-body constructor quirk and exercises the same path.
    fm.enqueueRaw(new Response('', { status: 200 }));
    await svc.addCollaborator({ slug: 'gen-matrix', username: 'dev-7' });
    expect(timeouts[timeouts.length - 1]).toBe(15000);

    fm.enqueue({ id: 1 });
    await svc.setCommitStatus({
      slug: 'gen-matrix',
      sha: 'abc',
      state: 'pending',
      context: 'civitai/build',
    });
    expect(timeouts[timeouts.length - 1]).toBe(15000);
  });

  it('respects overridden env timeouts (config-driven, not hardcoded)', async () => {
    // Re-mock the env module with different values, fresh-import the service.
    vi.resetModules();
    vi.doMock('~/env/server', () => ({
      env: {
        FORGEJO_BASE_URL: 'https://forgejo.example',
        FORGEJO_ADMIN_TOKEN: 'tok-test',
        FORGEJO_WEBHOOK_SECRET: 'sec-test',
        APPS_DOMAIN: 'civit.ai',
        FORGEJO_API_TIMEOUT_MS: 9000,
        FORGEJO_COMMIT_TIMEOUT_MS: 300000,
      },
    }));
    const { commitFiles } = await import('../forgejo.service');
    fm.enqueue({ commit: { id: 'commit_sha' } });
    fm.enqueue({ tree: [], truncated: false });
    fm.enqueue({ commit: { sha: 'new_commit_sha' } });

    await commitFiles({
      slug: 'gen-matrix',
      files: [{ path: 'a.txt', content: Buffer.from('hi') }],
      message: 'msg',
    });

    const treeIdx = fm.calls.findIndex((c) => c.url.includes('/git/trees/'));
    const commitIdx = fm.calls.findIndex((c) => c.url.endsWith('/contents'));
    expect(timeouts[treeIdx]).toBe(9000);
    expect(timeouts[commitIdx]).toBe(300000);

    vi.doUnmock('~/env/server');
    vi.resetModules();
  });
});

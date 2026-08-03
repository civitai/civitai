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
    // Recursive=true + per_page=1000 (the endpoint's own ceiling) + page=1.
    expect(fm.calls[1].url).toBe(
      'https://forgejo.example/api/v1/repos/civitai-apps/hello/git/trees/commit_sha?recursive=true&per_page=1000&page=1'
    );
    // A tree that fits in one page costs exactly one tree request.
    expect(fm.calls.filter((c) => c.url.includes('/git/trees/'))).toHaveLength(1);
    // Auth header carried.
    expect((fm.calls[0].init?.headers as Record<string, string>)['Authorization']).toBe(
      'token tok-test'
    );
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

// ---------------------------------------------------------------------------
// Tree pagination. Submit-time validation accepts up to MAX_FILES_IN_BUNDLE
// (2000) files but a single tree response holds at most 1000 entries, so an app
// over 1000 files MUST be read across pages. Before the fix this threw on the
// `truncated` flag, which made such an app impossible to approve / diff /
// preview once accepted.
//
// The pages below are deliberately SMALLER than the requested per_page: the
// server is free to clamp `per_page` down, so "a short page means the last
// page" is not a safe stop condition and the walk must not end on one.
// ---------------------------------------------------------------------------
describe('listRepoTreeAtRef pagination', () => {
  const treeCalls = () => fm.calls.filter((c) => c.url.includes('/git/trees/'));

  it('walks every page — including the final partial one — using total_count', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({
      tree: [
        { path: 'p1-a.txt', type: 'blob', sha: 's1a' },
        { path: 'dir', type: 'tree', sha: 'st1' },
        { path: 'p1-b.txt', type: 'blob', sha: 's1b' },
      ],
      truncated: true,
      total_count: 8,
    });
    fm.enqueue({
      tree: [
        { path: 'p2-a.txt', type: 'blob', sha: 's2a' },
        { path: 'p2-b.txt', type: 'blob', sha: 's2b' },
        { path: 'p2-c.txt', type: 'blob', sha: 's2c' },
      ],
      truncated: true,
      total_count: 8,
    });
    fm.enqueue({
      tree: [
        { path: 'p3-a.txt', type: 'blob', sha: 's3a' },
        { path: 'p3-b.txt', type: 'blob', sha: 's3b' },
      ],
      truncated: true,
      total_count: 8,
    });

    const result = await listRepoTreeAtRef('big', 'ref_sha');

    // Every page contributed — the LAST page is the one a loop that stops early
    // loses, so assert it explicitly.
    expect(result.get('p1-a.txt')).toBe('s1a');
    expect(result.get('p1-b.txt')).toBe('s1b');
    expect(result.get('p2-a.txt')).toBe('s2a');
    expect(result.get('p2-c.txt')).toBe('s2c');
    expect(result.get('p3-a.txt')).toBe('s3a');
    expect(result.get('p3-b.txt')).toBe('s3b');
    // Blobs only, all 7 of them; the directory entry is still excluded.
    expect(result.size).toBe(7);
    expect(result.has('dir')).toBe(false);

    // page= increments, per_page stays at the endpoint ceiling, and total_count
    // means no wasted trailing request.
    expect(treeCalls()).toHaveLength(3);
    expect(treeCalls()[0].url).toContain('recursive=true&per_page=1000&page=1');
    expect(treeCalls()[1].url).toContain('recursive=true&per_page=1000&page=2');
    expect(treeCalls()[2].url).toContain('recursive=true&per_page=1000&page=3');
  });

  it('walks every page when the response carries no total_count (truncated fallback)', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({
      tree: [{ path: 'p1.txt', type: 'blob', sha: 's1' }],
      truncated: true,
    });
    fm.enqueue({
      tree: [{ path: 'p2.txt', type: 'blob', sha: 's2' }],
      truncated: true,
    });
    // Short final page — must NOT be mistaken for "done"; only the empty page
    // that follows ends the walk.
    fm.enqueue({
      tree: [{ path: 'p3.txt', type: 'blob', sha: 's3' }],
      truncated: true,
    });
    fm.enqueue({ tree: [], truncated: true });

    const result = await listRepoTreeAtRef('big', 'ref_sha');
    expect([...result.keys()].sort()).toEqual(['p1.txt', 'p2.txt', 'p3.txt']);
    expect(treeCalls()).toHaveLength(4);
  });

  it('tolerates a null tree past the end of the listing', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({ tree: [{ path: 'a.txt', type: 'blob', sha: 's1' }], truncated: true });
    fm.enqueue({ tree: null, truncated: true });

    const result = await listRepoTreeAtRef('big', 'ref_sha');
    expect(result.get('a.txt')).toBe('s1');
  });

  it('stops after a single page when the tree is not truncated', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({
      tree: [{ path: 'only.txt', type: 'blob', sha: 's1' }],
      truncated: false,
      total_count: 1,
    });

    const result = await listRepoTreeAtRef('small', 'ref_sha');
    expect(result.size).toBe(1);
    expect(treeCalls()).toHaveLength(1);
  });

  it('gives up rather than paging forever when the host never says it is done', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // A server that always claims there is more, one entry at a time: the pager
    // must bail out at the REQUEST backstop instead of looping. The entry bound
    // (8000) is nowhere near reached, so the error must name the real reason
    // rather than blaming the app's file count.
    for (let i = 0; i < 200; i++) {
      fm.enqueue({ tree: [{ path: `f${i}.txt`, type: 'blob', sha: `s${i}` }], truncated: true });
    }

    await expect(listRepoTreeAtRef('runaway', 'ref_sha')).rejects.toThrow(
      /did not finish within 64 requests/
    );
    expect(treeCalls()).toHaveLength(64);
  });

  // --- The runaway bound must be on ENTRIES READ, not on page count. ---------
  // Deriving the request cap as MAX_TREE_ENTRIES / TREE_PAGE_SIZE assumes the
  // host honours the per_page we ask for — the exact assumption the stop
  // condition refuses to make. Under a host that clamps per_page, that pairing
  // rejects a legal tree with a message about a limit it never approached.
  it('reads a legal tree to completion even when the host clamps per_page far below the request', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // 1500 entries — comfortably legal (under both 2000 files and 8000 entries)
    // — served 100 at a time because the host clamped per_page.
    const CLAMPED = 100;
    const TOTAL = 1500;
    for (let page = 0; page * CLAMPED < TOTAL; page++) {
      fm.enqueue({
        tree: Array.from({ length: CLAMPED }, (_, i) => ({
          path: `f${page * CLAMPED + i}.txt`,
          type: 'blob',
          sha: `s${page * CLAMPED + i}`,
        })),
        truncated: true,
        total_count: TOTAL,
      });
    }

    const result = await listRepoTreeAtRef('clamped', 'ref_sha');
    expect(result.size).toBe(TOTAL);
    expect(result.get('f0.txt')).toBe('s0');
    expect(result.get('f1499.txt')).toBe('s1499');
    expect(treeCalls()).toHaveLength(TOTAL / CLAMPED);
  });

  it('names the entry bound — not the request bound — when the tree is genuinely oversized', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // Full 1000-entry pages of DIRECTORY entries, so the entry bound (8000) is
    // what trips rather than the blob/file cap.
    for (let page = 0; page < 12; page++) {
      fm.enqueue({
        tree: Array.from({ length: 1000 }, (_, i) => ({
          path: `d${page}/${i}`,
          type: 'tree',
          sha: `st${page}_${i}`,
        })),
        truncated: true,
      });
    }

    await expect(listRepoTreeAtRef('huge', 'ref_sha')).rejects.toThrow(/exceeds 8000 entries/);
    // 8000 entries / 1000 per page = 8 requests, then the entry bound stops it.
    expect(treeCalls()).toHaveLength(8);
  });

  // --- An empty response BODY is an error, not a past-the-end marker. --------
  // `unwrap` returns null for an empty body. Treating that the same as an
  // envelope with a null `tree` would return a silently PARTIAL tree, which
  // downstream becomes an incomplete approved bundle / a mirror that deletes
  // the files it failed to read.
  it('throws instead of silently truncating when a page comes back with an empty body', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({
      tree: [
        { path: 'p1-a.txt', type: 'blob', sha: 's1a' },
        { path: 'p1-b.txt', type: 'blob', sha: 's1b' },
        { path: 'p1-c.txt', type: 'blob', sha: 's1c' },
      ],
      truncated: true,
      total_count: 9,
    });
    // Empty 200 mid-walk: 3 of 9 entries read. Must NOT resolve.
    fm.enqueue(null);

    await expect(listRepoTreeAtRef('partial', 'ref_sha')).rejects.toThrow(
      /empty response body on page 2/
    );
  });

  // --- A too-small total_count must not be trusted into a short read. --------
  it('keeps paging past an under-reporting total_count when the page came back exactly full', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // total_count lies: it says 1000 while there are really 1002 entries. The
    // page came back EXACTLY full, which alone justifies one more probe.
    fm.enqueue({
      tree: Array.from({ length: 1000 }, (_, i) => ({
        path: `f${i}.txt`,
        type: 'blob',
        sha: `s${i}`,
      })),
      truncated: true,
      total_count: 1000,
    });
    fm.enqueue({
      tree: [
        { path: 'last-a.txt', type: 'blob', sha: 'sa' },
        { path: 'last-b.txt', type: 'blob', sha: 'sb' },
      ],
      truncated: false,
      total_count: 1000,
    });

    const result = await listRepoTreeAtRef('lying', 'ref_sha');
    // The two entries an under-reporting total_count would have dropped.
    expect(result.get('last-a.txt')).toBe('sa');
    expect(result.get('last-b.txt')).toBe('sb');
    expect(result.size).toBe(1002);
    expect(treeCalls()).toHaveLength(2);
  });

  it('keeps paging past an exactly-full page carrying neither total_count nor truncated', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // Neither field present: without the exactly-full probe this returns after
    // page 1 (truncated !== true) and silently drops page 2.
    fm.enqueue({
      tree: Array.from({ length: 1000 }, (_, i) => ({
        path: `f${i}.txt`,
        type: 'blob',
        sha: `s${i}`,
      })),
    });
    fm.enqueue({ tree: [{ path: 'tail.txt', type: 'blob', sha: 'st' }] });

    const result = await listRepoTreeAtRef('nometa', 'ref_sha');
    expect(result.get('tail.txt')).toBe('st');
    expect(result.size).toBe(1001);
    expect(treeCalls()).toHaveLength(2);
  });

  // --- The `total > 0` guard. -----------------------------------------------
  // A total_count of 0 alongside a non-empty page is self-contradictory, so it
  // must NOT be taken as authoritative — `seen >= 0` is true immediately and
  // would end the walk after page 1. The guard makes the code fall through to
  // the `truncated` fallback instead.
  it('ignores a total_count of 0 and falls through to the truncated fallback', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({
      tree: [{ path: 'p1.txt', type: 'blob', sha: 's1' }],
      truncated: true,
      total_count: 0,
    });
    fm.enqueue({
      tree: [{ path: 'p2.txt', type: 'blob', sha: 's2' }],
      truncated: true,
      total_count: 0,
    });
    fm.enqueue({
      tree: [{ path: 'p3.txt', type: 'blob', sha: 's3' }],
      truncated: false,
      total_count: 0,
    });

    const result = await listRepoTreeAtRef('zerototal', 'ref_sha');
    expect([...result.keys()].sort()).toEqual(['p1.txt', 'p2.txt', 'p3.txt']);
    expect(treeCalls()).toHaveLength(3);
  });

  // --- The seen >= total boundary. ------------------------------------------
  // 🔴 The multi-page fixture above steps 3+3+2 onto a total of 8, so `seen`
  // only ever meets `total` exactly on the nose and an off-by-one on the LOW
  // side (`seen + 1 >= total`) stays invisible. The discriminating shape is a
  // page that leaves `seen` exactly ONE short of `total` while a further page
  // still exists: there, `seen + 1 >= total` fires a page early and silently
  // drops the tail. Note an OVERSHOOTING fixture (e.g. 3+3+3 against 8) does
  // NOT discriminate — both forms stop on the same page.
  it('does not stop a page early when a page lands exactly one entry short of total_count', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // 3 + 4 + 1 = 8 against total_count 8: after page 2, seen === total - 1.
    fm.enqueue({
      tree: [
        { path: 'p1-a.txt', type: 'blob', sha: 's1a' },
        { path: 'p1-b.txt', type: 'blob', sha: 's1b' },
        { path: 'p1-c.txt', type: 'blob', sha: 's1c' },
      ],
      truncated: true,
      total_count: 8,
    });
    fm.enqueue({
      tree: [
        { path: 'p2-a.txt', type: 'blob', sha: 's2a' },
        { path: 'p2-b.txt', type: 'blob', sha: 's2b' },
        { path: 'p2-c.txt', type: 'blob', sha: 's2c' },
        { path: 'p2-d.txt', type: 'blob', sha: 's2d' },
      ],
      truncated: true,
      total_count: 8,
    });
    // The single trailing entry an off-by-one loses.
    fm.enqueue({
      tree: [{ path: 'p3-tail.txt', type: 'blob', sha: 's3tail' }],
      truncated: true,
      total_count: 8,
    });

    const result = await listRepoTreeAtRef('boundary', 'ref_sha');
    expect(result.get('p3-tail.txt')).toBe('s3tail');
    expect(result.size).toBe(8);
    expect(treeCalls()).toHaveLength(3);
  });

  // The mirror case: a page that OVERSHOOTS `total_count` must still terminate
  // on that page rather than paging on past the end.
  it('stops on a page that overshoots total_count', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // 3 + 3 + 3 = 9 entries read against a total of 8.
    for (const page of [1, 2, 3]) {
      fm.enqueue({
        tree: [
          { path: `p${page}-a.txt`, type: 'blob', sha: `s${page}a` },
          { path: `p${page}-b.txt`, type: 'blob', sha: `s${page}b` },
          { path: `p${page}-c.txt`, type: 'blob', sha: `s${page}c` },
        ],
        truncated: true,
        total_count: 8,
      });
    }

    const result = await listRepoTreeAtRef('overshoot', 'ref_sha');
    expect(result.get('p3-c.txt')).toBe('s3c');
    expect(result.size).toBe(9);
    expect(treeCalls()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The file cap. MAX_TREE_ENTRIES bounds tree ENTRIES (blobs + directories) as a
// loop guard; this bounds BLOBS — the quantity the limit error actually names,
// and the one submit-time validation caps. Without it the pager would hand back
// several thousand files from a function promising at most 2000.
// ---------------------------------------------------------------------------
describe('listRepoTreeAtRef file cap', () => {
  const treeCalls = () => fm.calls.filter((c) => c.url.includes('/git/trees/'));

  const blobPage = (start: number, count: number, extra: Record<string, unknown>) => ({
    tree: Array.from({ length: count }, (_, i) => ({
      path: `f${start + i}.txt`,
      type: 'blob',
      sha: `s${start + i}`,
    })),
    ...extra,
  });

  it('rejects a tree holding more blobs than an app may contain', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // 3000 blobs across 3 full pages — under the 8000-entry loop guard, but
    // over the 2000-file cap the error message names.
    fm.enqueue(blobPage(0, 1000, { truncated: true, total_count: 3000 }));
    fm.enqueue(blobPage(1000, 1000, { truncated: true, total_count: 3000 }));
    fm.enqueue(blobPage(2000, 1000, { truncated: false, total_count: 3000 }));
    // An exactly-full final page always costs one confirming probe.
    fm.enqueue({ tree: [], truncated: false, total_count: 3000 });

    await expect(listRepoTreeAtRef('toomany', 'ref_sha')).rejects.toThrow(
      /holds 3000 files; an app may contain at most 2000/
    );
  });

  it('accepts a tree of exactly MAX_FILES_IN_BUNDLE files', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue(blobPage(0, 1000, { truncated: true, total_count: 2000 }));
    fm.enqueue(blobPage(1000, 1000, { truncated: false, total_count: 2000 }));
    fm.enqueue({ tree: [], truncated: false, total_count: 2000 });

    const result = await listRepoTreeAtRef('atcap', 'ref_sha');
    expect(result.size).toBe(2000);
  });

  it('does not disturb the sub-cap happy path — one request, identical result', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    fm.enqueue({
      tree: [
        { path: 'block.manifest.json', type: 'blob', sha: 'sm' },
        { path: 'src', type: 'tree', sha: 'sd' },
        { path: 'src/index.tsx', type: 'blob', sha: 'si' },
      ],
      truncated: false,
      total_count: 3,
    });

    const result = await listRepoTreeAtRef('small', 'ref_sha');
    expect([...result.entries()]).toEqual([
      ['block.manifest.json', 'sm'],
      ['src/index.tsx', 'si'],
    ]);
    // Exactly one round-trip — the cap adds no request and no behaviour change
    // for a normal app.
    expect(treeCalls()).toHaveLength(1);
  });

  // The cap is on BLOBS, not entries: a directory-heavy repo under the file cap
  // must still pass even though its entry count is higher.
  it('counts blobs, not directory entries, against the file cap', async () => {
    const { listRepoTreeAtRef } = await import('../forgejo.service');
    // 1500 blobs + 1500 directory entries = 3000 entries, but only 1500 files.
    const entries = [
      ...Array.from({ length: 1500 }, (_, i) => ({
        path: `f${i}.txt`,
        type: 'blob',
        sha: `s${i}`,
      })),
      ...Array.from({ length: 1500 }, (_, i) => ({ path: `d${i}`, type: 'tree', sha: `st${i}` })),
    ];
    fm.enqueue({ tree: entries.slice(0, 1000), truncated: true, total_count: 3000 });
    fm.enqueue({ tree: entries.slice(1000, 2000), truncated: true, total_count: 3000 });
    fm.enqueue({ tree: entries.slice(2000), truncated: false, total_count: 3000 });
    fm.enqueue({ tree: [], truncated: false, total_count: 3000 });

    const result = await listRepoTreeAtRef('dirheavy', 'ref_sha');
    expect(result.size).toBe(1500);
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

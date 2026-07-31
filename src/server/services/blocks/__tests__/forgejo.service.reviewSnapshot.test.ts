import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the in-review SNAPSHOT repo lifecycle on the Forgejo client:
 * create-private (the #3495 security fix), enumerate, flip-to-private (backfill)
 * and delete (retention).
 *
 * Strategy mirrors forgejo.service.test.ts: mock global.fetch and assert on the
 * URLs + bodies the service sends. No real HTTP, no real Forgejo.
 */

vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok-test',
    FORGEJO_WEBHOOK_SECRET: 'sec-test',
    APPS_DOMAIN: 'civit.ai',
    FORGEJO_API_TIMEOUT_MS: 15000,
    FORGEJO_COMMIT_TIMEOUT_MS: 120000,
  },
}));

type FetchCall = { url: string; init?: RequestInit };

function makeFetchMock() {
  const calls: FetchCall[] = [];
  const responses: Array<Response> = [];
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
      responses.push(new Response(text, { status, headers: { 'Content-Type': 'application/json' } }));
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

const bodyOf = (call: FetchCall) => JSON.parse(String(call.init?.body ?? '{}'));

describe('ensureReviewRepo — snapshot visibility', () => {
  /**
   * 🔴 THE SECURITY ASSERTION. In-review snapshots hold the full source of an
   * UNAPPROVED third-party submission, keyed by a guessable slug. `private:true`
   * is the only control that survives a change to how requests reach the review
   * source host — which is exactly the composition that made this a bug.
   */
  it('creates the snapshot repo PRIVATE', async () => {
    const { ensureReviewRepo } = await import('../forgejo.service');
    fm.enqueue({ id: 1 }); // org create
    fm.enqueue({ id: 2 }); // repo create

    await ensureReviewRepo('gen-matrix');

    const repoCreate = fm.calls.find((c) => c.url.endsWith('/orgs/civitai-apps-review/repos'));
    expect(repoCreate, 'repo-create call').toBeTruthy();
    expect(bodyOf(repoCreate!).private).toBe(true);
    // auto_init must survive the change — commitFiles pushes to `main` right after.
    expect(bodyOf(repoCreate!).auto_init).toBe(true);
  });

  it('keeps the containing org private too', async () => {
    const { ensureReviewRepo } = await import('../forgejo.service');
    fm.enqueue({ id: 1 });
    fm.enqueue({ id: 2 });

    await ensureReviewRepo('gen-matrix');

    const orgCreate = fm.calls.find((c) => c.url.endsWith('/api/v1/orgs'));
    expect(bodyOf(orgCreate!).visibility).toBe('private');
  });

  it('stays idempotent: 409/422 on an existing repo is not an error', async () => {
    const { ensureReviewRepo } = await import('../forgejo.service');
    fm.enqueue({ message: 'org exists' }, 422);
    fm.enqueue({ message: 'repo exists' }, 409);

    await expect(ensureReviewRepo('gen-matrix')).resolves.toBeUndefined();
  });
});

describe('deleteReviewRepo', () => {
  it('DELETEs the per-slug repo and reports `deleted`', async () => {
    const { deleteReviewRepo } = await import('../forgejo.service');
    fm.enqueueRaw(new Response(null, { status: 204 }));

    await expect(deleteReviewRepo('gen-matrix')).resolves.toBe('deleted');

    expect(fm.calls[0].url).toBe('https://forgejo.example/api/v1/repos/civitai-apps-review/gen-matrix');
    expect(fm.calls[0].init?.method).toBe('DELETE');
  });

  /**
   * Idempotency is what lets the sweep be re-run / resumed freely: a repo that
   * a previous run already reclaimed must not read as a failure.
   */
  it('treats 404 as SUCCESS (`already-gone`), not an error', async () => {
    const { deleteReviewRepo } = await import('../forgejo.service');
    fm.enqueue({ message: 'not found' }, 404);

    await expect(deleteReviewRepo('gen-matrix')).resolves.toBe('already-gone');
  });

  it('throws on a real failure (403/500) so the caller counts it as failed', async () => {
    const { deleteReviewRepo } = await import('../forgejo.service');
    fm.enqueue({ message: 'nope' }, 403);
    await expect(deleteReviewRepo('gen-matrix')).rejects.toThrow(/403/);

    fm.enqueue({ message: 'boom' }, 500);
    await expect(deleteReviewRepo('gen-matrix')).rejects.toThrow(/500/);
  });

  /**
   * The snapshot org is a derived cache; the canonical `civitai-apps` org is the
   * system of record for a pushed app. This function must be structurally unable
   * to point at the latter.
   */
  it('can only ever target the in-review org, never the canonical app org', async () => {
    const { deleteReviewRepo } = await import('../forgejo.service');
    fm.enqueueRaw(new Response(null, { status: 204 }));

    await deleteReviewRepo('gen-matrix');

    expect(fm.calls[0].url).toContain('/repos/civitai-apps-review/');
    expect(fm.calls[0].url).not.toContain('/repos/civitai-apps/');
  });

  it('url-encodes the slug', async () => {
    const { deleteReviewRepo } = await import('../forgejo.service');
    fm.enqueueRaw(new Response(null, { status: 204 }));

    await deleteReviewRepo('weird/slug');

    expect(fm.calls[0].url).toContain('weird%2Fslug');
  });
});

describe('setReviewRepoPrivate', () => {
  it('PATCHes private:true on the per-slug repo', async () => {
    const { setReviewRepoPrivate } = await import('../forgejo.service');
    fm.enqueue({ id: 1, private: true });

    await expect(setReviewRepoPrivate('gen-matrix')).resolves.toBe('updated');

    expect(fm.calls[0].url).toBe('https://forgejo.example/api/v1/repos/civitai-apps-review/gen-matrix');
    expect(fm.calls[0].init?.method).toBe('PATCH');
    expect(bodyOf(fm.calls[0])).toEqual({ private: true });
  });

  it('reports `missing` on 404 rather than throwing (tolerates a vanished repo)', async () => {
    const { setReviewRepoPrivate } = await import('../forgejo.service');
    fm.enqueue({ message: 'not found' }, 404);

    await expect(setReviewRepoPrivate('gen-matrix')).resolves.toBe('missing');
  });

  it('throws on a non-404 failure', async () => {
    const { setReviewRepoPrivate } = await import('../forgejo.service');
    fm.enqueue({ message: 'nope' }, 403);

    await expect(setReviewRepoPrivate('gen-matrix')).rejects.toThrow(/403/);
  });
});

describe('listReviewRepos', () => {
  it('pages until a short page and returns name + private for each', async () => {
    const { listReviewRepos } = await import('../forgejo.service');
    fm.enqueue([
      { name: 'a', private: false },
      { name: 'b', private: true },
    ]);
    fm.enqueue([{ name: 'c', private: false }]);

    const repos = await listReviewRepos({ perPage: 2 });

    expect(repos).toEqual([
      { name: 'a', private: false },
      { name: 'b', private: true },
      { name: 'c', private: false },
    ]);
    expect(fm.calls).toHaveLength(2);
    expect(fm.calls[0].url).toContain('page=1&limit=2');
    expect(fm.calls[1].url).toContain('page=2&limit=2');
  });

  it('returns empty when the org does not exist yet (404), rather than throwing', async () => {
    const { listReviewRepos } = await import('../forgejo.service');
    fm.enqueue({ message: 'not found' }, 404);

    await expect(listReviewRepos()).resolves.toEqual([]);
  });

  it('stops at maxPages so a looping pager can never spin forever', async () => {
    const { listReviewRepos } = await import('../forgejo.service');
    // Always a FULL page → the "short page" stop condition never fires.
    for (let i = 0; i < 5; i++) fm.enqueue([{ name: `r${i}`, private: false }]);

    const repos = await listReviewRepos({ perPage: 1, maxPages: 3 });

    expect(repos).toHaveLength(3);
    expect(fm.calls).toHaveLength(3);
  });
});

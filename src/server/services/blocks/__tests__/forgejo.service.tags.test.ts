import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ensureApprovalTag` and `getTagCommitSha` against a fetch-level fake of Forgejo's tag API.
 * The approve-path wiring (trailers, ordering, log-and-continue) is in
 * publish-request.orchestration.test.ts; the naming rule is in approve-provenance.test.ts.
 */

vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok-test',
    FORGEJO_API_TIMEOUT_MS: 15000,
    FORGEJO_COMMIT_TIMEOUT_MS: 120000,
  },
}));

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAGS = '/api/v1/repos/civitai-apps/hello/tags';

type Call = { method: string; path: string; body?: Record<string, unknown> };

let calls: Call[];
let tags: Map<string, string>;
/** Tags that a "concurrent approve" creates the moment our POST arrives. */
let raceOnCreate: Map<string, string>;

beforeEach(() => {
  calls = [];
  tags = new Map();
  raceOnCreate = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status });
      if (method === 'GET' && url.pathname.startsWith(`${TAGS}/`)) {
        const name = decodeURIComponent(url.pathname.slice(TAGS.length + 1));
        const sha = tags.get(name);
        return sha ? json(200, { name, id: 'tag-object-sha', commit: { sha } }) : json(404, {});
      }
      if (method === 'POST' && url.pathname === TAGS) {
        const name = body.tag_name as string;
        const raced = raceOnCreate.get(name);
        if (raced) tags.set(name, raced);
        if (tags.has(name)) return json(409, { message: 'tag exists' });
        tags.set(name, body.target as string);
        return json(201, { name, commit: { sha: body.target } });
      }
      throw new Error(`unmodelled ${method} ${url.pathname}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = async (
  over: Partial<{ version: string; publishRequestId: string; sha: string }> = {}
) => {
  const { ensureApprovalTag } = await import('../forgejo.service');
  return ensureApprovalTag({
    slug: 'hello',
    version: '1.0.0',
    publishRequestId: 'pubreq_9',
    sha: SHA,
    message: 'Approved publish request pubreq_9 — hello v1.0.0\n\nPublish-Request: pubreq_9\n',
    ...over,
  });
};

const tagPosts = () => calls.filter((c) => c.method === 'POST').map((c) => c.body);

describe('getTagCommitSha', () => {
  it('reads the TARGET commit of an annotated tag, not the tag object', async () => {
    tags.set('v1.0.0', SHA);
    const { getTagCommitSha } = await import('../forgejo.service');
    await expect(getTagCommitSha('hello', 'v1.0.0')).resolves.toEqual({ commitSha: SHA });
  });

  it('a missing tag is null; a server error throws', async () => {
    const { getTagCommitSha } = await import('../forgejo.service');
    await expect(getTagCommitSha('hello', 'v9.9.9')).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 }))
    );
    await expect(getTagCommitSha('hello', 'v1.0.0')).rejects.toThrow(/Forgejo 503/);
  });

  it('url-encodes the tag name (build metadata carries a `+`)', async () => {
    const { getTagCommitSha } = await import('../forgejo.service');
    await getTagCommitSha('hello', 'v1.0.0+build.1');
    expect(calls[0].path).toBe(`${TAGS}/v1.0.0%2Bbuild.1`);
  });
});

describe('ensureApprovalTag', () => {
  it('🔴 creates an ANNOTATED v<version> on the approved commit', async () => {
    await expect(run()).resolves.toEqual({ status: 'created', tag: 'v1.0.0' });
    expect(tagPosts()).toEqual([
      {
        tag_name: 'v1.0.0',
        target: SHA,
        message: 'Approved publish request pubreq_9 — hello v1.0.0\n\nPublish-Request: pubreq_9\n',
      },
    ]);
  });

  it('is idempotent: the tag already on this commit is not re-created', async () => {
    tags.set('v1.0.0', SHA);
    await expect(run()).resolves.toEqual({ status: 'exists', tag: 'v1.0.0' });
    expect(tagPosts()).toEqual([]);
  });

  it('🔴 never moves v<version> off another commit; tags approved-<id> instead', async () => {
    tags.set('v1.0.0', OTHER);
    await expect(run()).resolves.toEqual({
      status: 'created',
      tag: 'approved-pubreq_9',
      fallbackFrom: { tag: 'v1.0.0', sha: OTHER },
    });
    expect(tags.get('v1.0.0')).toBe(OTHER);
    expect(tagPosts().map((b) => [b?.tag_name, b?.target])).toEqual([['approved-pubreq_9', SHA]]);
  });

  it('a re-delivery of that fallback finds approved-<id> and creates nothing', async () => {
    tags.set('v1.0.0', OTHER);
    tags.set('approved-pubreq_9', SHA);
    await expect(run()).resolves.toMatchObject({ status: 'exists', tag: 'approved-pubreq_9' });
    expect(tagPosts()).toEqual([]);
  });

  it('approved-<id> on a different commit is reported, not overwritten', async () => {
    tags.set('v1.0.0', OTHER);
    tags.set('approved-pubreq_9', OTHER);
    await expect(run()).resolves.toEqual({
      status: 'skipped',
      reason: `approved-pubreq_9 already names ${OTHER}`,
    });
    expect(tagPosts()).toEqual([]);
  });

  it('lost the race for v<version> to the SAME commit (concurrent re-delivery): exists', async () => {
    raceOnCreate.set('v1.0.0', SHA);
    await expect(run()).resolves.toEqual({ status: 'exists', tag: 'v1.0.0' });
  });

  it('lost the race for v<version> to ANOTHER commit: falls back to approved-<id>', async () => {
    raceOnCreate.set('v1.0.0', OTHER);
    await expect(run()).resolves.toMatchObject({ status: 'created', tag: 'approved-pubreq_9' });
    expect(tags.get('v1.0.0')).toBe(OTHER);
    expect(tags.get('approved-pubreq_9')).toBe(SHA);
  });

  it('a non-semver version is skipped without any Forgejo call', async () => {
    await expect(run({ version: 'latest' })).resolves.toEqual({
      status: 'skipped',
      reason: 'version "latest" is not semver',
    });
    expect(calls).toEqual([]);
  });

  it('a 422 (protected tag name) throws with the server reason instead of reading as a race', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'POST'
          ? new Response(JSON.stringify({ message: 'tag is protected' }), { status: 422 })
          : new Response('{}', { status: 404 })
      )
    );
    await expect(run()).rejects.toThrow(/Forgejo 422.*tag is protected/);
  });

  it('a Forgejo error throws (the approve path logs and continues)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 }))
    );
    await expect(run()).rejects.toThrow(/Forgejo 500/);
  });
});

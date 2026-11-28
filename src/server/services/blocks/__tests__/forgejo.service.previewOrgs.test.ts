import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Forgejo client under a PR preview's configuration: its own three orgs and a bot token that
 * is a member of them but neither a site admin nor allowed to create orgs. Every request must
 * land in the preview orgs, and a refused org config must reach Forgejo not at all.
 *
 * Mocks global.fetch, like forgejo.service.reviewSnapshot.test.ts.
 */

const mockEnv: Record<string, unknown> = {};
vi.mock('~/env/server', () => ({ env: mockEnv }));

const BASE_ENV = {
  FORGEJO_BASE_URL: 'https://forgejo.example',
  FORGEJO_ADMIN_TOKEN: 'tok-bot',
  FORGEJO_API_TIMEOUT_MS: 15000,
  FORGEJO_COMMIT_TIMEOUT_MS: 120000,
};
const PREVIEW_ORGS = {
  FORGEJO_APPS_ORG: 'civitai-apps-preview',
  FORGEJO_REVIEW_ORG: 'civitai-apps-preview-review',
  FORGEJO_SRC_ORG: 'civitai-apps-preview-src',
};

type Call = { method: string; url: string };
let calls: Call[];
let responses: Response[];

function enqueue(status: number, body: unknown = {}) {
  responses.push(new Response(JSON.stringify(body), { status }));
}

async function load(env: Record<string, unknown>) {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  Object.assign(mockEnv, BASE_ENV, env);
  vi.resetModules();
  return import('../forgejo.service');
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      const r = responses.shift();
      if (!r) throw new Error(`fetch mock: no queued response for ${String(url)}`);
      return r;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preview orgs', () => {
  it('exports the configured orgs, which the git-push webhook gate reads', async () => {
    const svc = await load(PREVIEW_ORGS);
    expect([svc.FORGEJO_ORG, svc.FORGEJO_REVIEW_ORG, svc.FORGEJO_SOURCE_ORG]).toEqual([
      'civitai-apps-preview',
      'civitai-apps-preview-review',
      'civitai-apps-preview-src',
    ]);
  });

  it('submit path: the review repo is looked up and created in the preview review org only', async () => {
    const { ensureReviewRepo } = await load(PREVIEW_ORGS);
    enqueue(200); // org exists
    enqueue(201); // repo created

    await ensureReviewRepo('my-app');

    expect(calls).toEqual([
      { method: 'GET', url: 'https://forgejo.example/api/v1/orgs/civitai-apps-preview-review' },
      {
        method: 'POST',
        url: 'https://forgejo.example/api/v1/orgs/civitai-apps-preview-review/repos',
      },
    ]);
  });

  it('commitFiles defaults to the preview build org', async () => {
    const { commitFiles } = await load(PREVIEW_ORGS);
    enqueue(200, { commit: { id: 'c1' } }); // branch
    enqueue(200, { tree: [], truncated: false }); // tree
    enqueue(201, { commit: { sha: 'c2' } }); // contents

    await commitFiles({
      slug: 'my-app',
      files: [{ path: 'a.txt', content: Buffer.from('hi') }],
      message: 'm',
    });

    expect(calls.map((c) => c.url)).toEqual([
      'https://forgejo.example/api/v1/repos/civitai-apps-preview/my-app/branches/main',
      expect.stringMatching(
        /^https:\/\/forgejo\.example\/api\/v1\/repos\/civitai-apps-preview\/my-app\/git\/trees\/c1\?/
      ),
      'https://forgejo.example/api/v1/repos/civitai-apps-preview/my-app/contents',
    ]);
  });

  it('source repos go to the preview source org', async () => {
    const { ensureSourceRepo } = await load(PREVIEW_ORGS);
    enqueue(200); // org exists
    enqueue(201); // repo created

    await expect(ensureSourceRepo('my-app')).resolves.toEqual({ created: true });
    expect(calls[1].url).toBe('https://forgejo.example/api/v1/orgs/civitai-apps-preview-src/repos');
  });

  it('a refused org config sends nothing to Forgejo', async () => {
    const { ensureReviewRepo, getRepo } = await load({
      ...PREVIEW_ORGS,
      FORGEJO_REVIEW_ORG: 'civitai-apps-review', // production's review org
    });

    await expect(ensureReviewRepo('my-app')).rejects.toThrow(
      'Forgejo org config refused: FORGEJO_REVIEW_ORG names the production org civitai-apps-review'
    );
    await expect(getRepo('my-app')).rejects.toThrow(/Forgejo org config refused/);
    expect(calls).toEqual([]);
  });

  it('a refused org config also stops the direct-fetch paths (raw file, token mint)', async () => {
    const { getRawFile, mintForgejoUserToken } = await load({
      ...PREVIEW_ORGS,
      FORGEJO_SRC_ORG: undefined,
    });

    await expect(getRawFile({ slug: 'my-app', ref: 'abc', path: 'a.txt' })).rejects.toThrow(
      /Forgejo org config refused/
    );
    await expect(
      mintForgejoUserToken({ username: 'dev-1', password: 'p', name: 'n', scopes: [] })
    ).rejects.toThrow(/Forgejo org config refused/);
    expect(calls).toEqual([]);
  });

  it('collaborator rows cannot be written in the review org', async () => {
    const { addCollaborator, removeCollaborator, FORGEJO_REVIEW_ORG } = await load(PREVIEW_ORGS);

    await expect(
      addCollaborator({ slug: 'my-app', username: 'dev-1', org: FORGEJO_REVIEW_ORG })
    ).rejects.toThrow(
      'collaborator rows may change only in civitai-apps-preview or civitai-apps-preview-src, not civitai-apps-preview-review'
    );
    await expect(
      removeCollaborator({ slug: 'my-app', username: 'dev-1', org: FORGEJO_REVIEW_ORG })
    ).rejects.toThrow(/collaborator rows may change only/);
    expect(calls).toEqual([]);
  });

  it('per-developer git identities fail with the reason on a non-admin token', async () => {
    const { createForgejoUser } = await load(PREVIEW_ORGS);
    enqueue(403, { message: 'user should be an admin' });

    await expect(
      createForgejoUser({ username: 'dev-1', email: 'dev-1@apps.civitai.invalid' })
    ).rejects.toThrow(
      "Forgejo refused to create the developer git identity (403): this environment's Forgejo token is not a site admin"
    );
  });
});

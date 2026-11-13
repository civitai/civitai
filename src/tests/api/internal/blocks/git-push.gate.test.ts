import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * No-trust-on-push coverage for POST /api/internal/blocks/git-push.
 *
 * The finding: a signature-valid Forgejo push to civitai-apps/<slug>:main for
 * an already-approved block used to run
 * `dbWrite.appBlock.update({ status: 'approved' })` + trigger the Tekton build —
 * shipping unreviewed iframe code to a live, mod-page-embedded block. Forgejo
 * write access is a different trust domain than civitai moderation.
 *
 * The fix: git-push NEVER auto-approves and NEVER deploys. The build is owned
 * by approveRequest (the moderator path), which stamps the approved sha onto
 * app_blocks.current_version_sha before its commit fires this webhook. So:
 *   - sha === current_version_sha (or an `approved` publish request matches the
 *     sha) → the in-flight moderator-approved deploy → no-op.
 *   - any other sha → an UNREVIEWED direct push → recorded as a `pending`
 *     publish request, no status flip, no build. A moderator must approve it.
 *
 * These tests drive the real default export with a real signed body (bodyParser
 * is off, so the handler reads + HMAC-verifies the raw stream), mirroring the
 * build-callback handler tests.
 */

const SECRET = 'test-forgejo-webhook-secret';
const SLUG = 'generate-from-model';
const APPROVED_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const APP_BLOCK_ID = 'apb_0123456789ABCDEFGHJKMNPQRS';

const {
  mockFlag,
  mockGetRawFile,
  mockSetCommitStatus,
  mockValidate,
  mockAppBlockFindFirst,
  mockAppBlockFindUnique,
  mockAppBlockUpdate,
  mockPubReqFindFirst,
  mockPubReqCreate,
  mockPubReqUpdate,
  mockPubReqUpdateMany,
  mockNewUlid,
  mockTriggerBuild,
  mockFetch,
  state,
} = vi.hoisted(() => {
  const state = {
    flagEnabled: true,
    // `app-blocks-review-autodeploy`: gates the new-submission alert (and the automatic preview).
    autodeployEnabled: false,
    // app_blocks row returned by findFirst (null = not provisioned yet → 404)
    appBlock: null as null | Record<string, unknown>,
    // approved publish request match for (slug, sha) — race backstop
    approvedPubReqForSha: null as null | { id: string },
    // existing pending row for (slug, sha) — idempotent refresh
    pendingPubReqForSha: null as null | { id: string },
    // manifest served by Forgejo at the pushed sha
    manifest: {} as Record<string, unknown>,
    validation: { valid: true, errors: [] as string[] },
  };
  return {
    state,
    mockFlag: {
      get enabled() {
        return state.flagEnabled;
      },
    },
    mockGetRawFile: vi.fn(async () => JSON.stringify(state.manifest)),
    mockSetCommitStatus: vi.fn(async () => undefined),
    mockValidate: vi.fn(() => state.validation),
    mockAppBlockFindFirst: vi.fn(async () => state.appBlock),
    mockAppBlockFindUnique: vi.fn(async () => ({ app: { userId: 77 } })),
    mockAppBlockUpdate: vi.fn(async () => undefined),
    mockPubReqFindFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.status === 'approved') return state.approvedPubReqForSha;
      if (where.status === 'pending') return state.pendingPubReqForSha;
      return null;
    }),
    mockPubReqCreate: vi.fn(async (_args: { data: Record<string, unknown> }) => undefined),
    mockPubReqUpdate: vi.fn(async () => undefined),
    mockPubReqUpdateMany: vi.fn(async () => ({ count: 0 })),
    mockNewUlid: vi.fn(() => '0123456789ABCDEFGHJKMNPQRS'),
    mockTriggerBuild: vi.fn(async () => ({ name: 'pr-1' })),
    mockFetch: vi.fn(async () => ({ ok: true, status: 204 })),
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      FORGEJO_WEBHOOK_SECRET: SECRET,
      APPS_DOMAIN: 'civit.ai',
      DISCORD_WEBHOOK_MOD_ALERTS: 'https://discord.test/webhook',
    } as Record<string, unknown>,
    {
      get(t, p: string) {
        if (p in t) return t[p];
        if (p === 'LOGGING') return '';
        return undefined;
      },
    }
  ),
}));
// Per-key Flipt mock: git-push now gates on the dedicated
// `app-blocks-pipeline-enabled` PIPELINE flag (Decision 1), NOT the user-facing
// `app-blocks-enabled`. Only the pipeline key reflects the toggle; the user flag
// is hard-false so a regression that repointed back to it would 503.
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) =>
    flag === 'app-blocks-pipeline-enabled'
      ? mockFlag.enabled
      : flag === 'app-blocks-review-autodeploy'
      ? state.autodeployEnabled
      : false
  ),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    appBlock: { findFirst: mockAppBlockFindFirst, findUnique: mockAppBlockFindUnique },
    appBlockPublishRequest: { findFirst: mockPubReqFindFirst },
    // The new-submission moderator alert names the author.
    user: { findUnique: async () => ({ username: 'author' }) },
  },
  dbWrite: {
    appBlock: { update: mockAppBlockUpdate },
    appBlockPublishRequest: {
      findFirst: mockPubReqFindFirst,
      create: mockPubReqCreate,
      update: mockPubReqUpdate,
      updateMany: mockPubReqUpdateMany,
      // The supersede read: no other pending request with a preview to tear down.
      findMany: async () => [],
    },
  },
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  // validateSubmission is the async submission gate the handler now calls; it
  // wraps validate + the settings-pattern ReDoS check. Point it at the same mock
  // so `state.validation` drives the outcome as before.
  BlockManifestValidator: { validate: mockValidate, validateSubmission: mockValidate },
}));
// listRepoTreeAtRef + getBlobContent included to avoid this partial factory leaking into a co-resident
// file (push-diff-enrichment) whose REAL publish-request.service reaches them — see build-callback.test.ts.
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  getRawFile: mockGetRawFile,
  setCommitStatus: mockSetCommitStatus,
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newUlid: mockNewUlid }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: mockTriggerBuild,
}));

import { isFlipt } from '~/server/flipt/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { appDeveloperTermsRefusalMessage } from '~/shared/constants/app-developer-terms.constants';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
// Publish paths here run as a developer who accepted the App Developer Terms; a test that needs the
// refusal overrides the stub.
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

const mockedIsFlipt = vi.mocked(isFlipt);

function validManifest(sha = NEW_SHA) {
  return {
    blockId: SLUG,
    version: '0.2.0',
    name: 'Generate From Model',
    iframe: { src: `https://${SLUG}.civit.ai/` },
    _sha: sha, // marker only; ignored by handler
  };
}

function pushBody(opts: { ref?: string; fullName?: string; after?: string }) {
  return {
    ref: opts.ref ?? 'refs/heads/main',
    after: opts.after ?? NEW_SHA,
    before: '0'.repeat(40),
    repository: { name: SLUG, full_name: opts.fullName ?? `civitai-apps/${SLUG}` },
    pusher: { login: 'someone', username: 'someone' },
    commits: [{ id: opts.after ?? NEW_SHA, message: 'update' }],
  };
}

function signedReq(bodyObj: Record<string, unknown>, sigOverride?: string): NextApiRequest {
  const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const sig = sigOverride ?? 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  return {
    method: 'POST',
    headers: { 'x-forgejo-signature': sig },
    async *[Symbol.asyncIterator]() {
      yield raw;
    },
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { _status: number; _body: any } {
  const res = {
    _status: 0,
    _body: null as any,
    status: vi.fn(function (this: any, n: number) {
      this._status = n;
      return this;
    }),
    json: vi.fn(function (this: any, b: unknown) {
      this._body = b;
      return this;
    }),
    end: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & { _status: number; _body: any };
}

async function invoke(req: NextApiRequest, res: NextApiResponse) {
  const handler = (await import('~/pages/api/internal/blocks/git-push')).default;
  await handler(req, res);
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('git-push webhook — no-trust-on-push gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    state.flagEnabled = true;
    state.autodeployEnabled = false;
    state.appBlock = {
      id: APP_BLOCK_ID,
      appId: `appblk-${SLUG}`,
      blockId: SLUG,
      currentVersionSha: APPROVED_SHA,
      app: { id: `appblk-${SLUG}`, allowedScopes: 0, allowedOrigins: [`https://${SLUG}.civit.ai`] },
    };
    state.approvedPubReqForSha = null;
    state.pendingPubReqForSha = null;
    state.manifest = validManifest(NEW_SHA);
    state.validation = { valid: true, errors: [] };
  });

  afterEach(async () => {
    await flush();
    vi.unstubAllGlobals();
  });

  // ---- the mod-alerts Discord ping ----------------------------------------
  // The park path (202) is the SUCCESS path of the "Author via git" flow. It must NOT raise the
  // red "Apps build-chain rejected" failure alarm (noisy, ~1/day from fleet automation); the
  // genuine failure stages keep that. With `app-blocks-review-autodeploy` on, a NEW pending
  // request posts the one neutral "New app submission" alert (review-autodeploy.service); off, none.

  it('autodeploy flag OFF: a parked unreviewed push does NOT ping the mod-alerts webhook', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(202);
    expect(mockPubReqCreate).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('autodeploy flag ON: a parked unreviewed push posts only the new-submission alert, never the failure alarm', async () => {
    state.autodeployEnabled = true;
    // The per-submitter alert throttle reads a counter: first alert of the hour. The automatic
    // build's budget counter is left unreadable, so no preview is queued from this test.
    redisMock.sysRedis.multi.mockImplementation(() => {
      let key = '';
      const chain = {
        set: vi.fn((k: string) => {
          key = k;
          return chain;
        }),
        incr: vi.fn(() => chain),
        exec: vi.fn(async () => {
          if (!key.includes('review-submission-alerts')) throw new Error('not in this test');
          return ['OK', 1];
        }),
      };
      return chain;
    });
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(202);
    // The alert is fire-and-forget after the response.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 15_000 });
    const titles = mockFetch.mock.calls.map(
      (c) =>
        (
          JSON.parse((c as unknown as [string, { body: string }])[1].body) as {
            embeds: Array<{ title: string }>;
          }
        ).embeds[0].title
    );
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatch(/^New app submission: /);
  });

  it('a re-delivery of the same parked sha does NOT ping the mod-alerts webhook at all', async () => {
    state.pendingPubReqForSha = { id: 'pubreq_existing' };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(202);
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a manifest-validation failure stage STILL pings the mod-alerts webhook', async () => {
    state.validation = { valid: false, errors: ['scopes: forbidden'] };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://discord.test/webhook');
    const payload = JSON.parse(init.body) as { embeds: Array<{ title: string }> };
    expect(payload.embeds[0].title).toContain('Apps build-chain rejected');
  });

  // ---- the core fix --------------------------------------------------------

  it('🔴 git-push re-validates with the issue-tracker link LENIENT (a stored legacy `bugs` warns, never refuses)', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(mockValidate).toHaveBeenCalled();
    expect(
      mockValidate.mock.calls.some(
        (c: unknown[]) =>
          (c[2] as { strictIssueTrackerLink?: boolean } | undefined)?.strictIssueTrackerLink ===
          false
      )
    ).toBe(true);
  });

  it('a NEW signed push to an existing approved block does NOT approve or deploy — it parks a PENDING review request', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);

    // No deploy, no status flip to approved.
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    expect(mockAppBlockUpdate).not.toHaveBeenCalled();

    // A pending review artifact was created for the new sha.
    expect(mockPubReqCreate).toHaveBeenCalledTimes(1);
    const createArg = mockPubReqCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArg.data).toMatchObject({
      slug: SLUG,
      status: 'pending',
      forgejoCommitSha: NEW_SHA,
      appBlockId: APP_BLOCK_ID,
    });

    // Response signals pending-review, not deployed.
    expect(res._status).toBe(202);
    expect(res._body).toMatchObject({ status: 'pending-review', deployed: false });
  });

  it('an owner who has not accepted the App Developer Terms: 403, a failure status linking to where to accept, nothing parked, no mod ping', async () => {
    const terms = await import('~/server/services/blocks/app-developer-terms.service');
    vi.mocked(terms.assertAcceptedAppDeveloperTerms).mockRejectedValueOnce(
      new terms.AppDeveloperTermsNotAcceptedError(
        appDeveloperTermsRefusalMessage('https://civitai.com')
      )
    );
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(403);
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failure',
        description: expect.stringContaining('/content/app-developer-terms'),
        targetUrl: expect.stringMatching(/\/apps\/submit$/),
      })
    );
    expect(mockPubReqUpdateMany).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("checks the pusher's own acceptance, mapped from the dev-<userId> Forgejo handle", async () => {
    const terms = await import('~/server/services/blocks/app-developer-terms.service');
    const body = {
      ...pushBody({ after: NEW_SHA }),
      pusher: { login: 'dev-42', username: 'dev-42' },
    };
    await invoke(signedReq(body), makeRes());
    expect(vi.mocked(terms.assertAcceptedAppDeveloperTerms)).toHaveBeenCalledWith(42);
  });

  it("a collaborator's push blocked by the OWNER says the owner must accept, not the pusher", async () => {
    const terms = await import('~/server/services/blocks/app-developer-terms.service');
    vi.mocked(terms.hasAcceptedAppDeveloperTerms).mockResolvedValueOnce(false);
    const body = {
      ...pushBody({ after: NEW_SHA }),
      pusher: { login: 'dev-42', username: 'dev-42' },
    };
    const res = makeRes();
    await invoke(signedReq(body), res);
    expect(res._status).toBe(403);
    expect(vi.mocked(terms.hasAcceptedAppDeveloperTerms)).toHaveBeenCalledWith(77);
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failure',
        description: expect.stringMatching(/^The app's owner has not accepted/),
      })
    );
    expect(mockPubReqUpdateMany).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  it("a collaborator's push blocked by the PUSHER shows the pusher's own refusal", async () => {
    const terms = await import('~/server/services/blocks/app-developer-terms.service');
    vi.mocked(terms.assertAcceptedAppDeveloperTerms).mockRejectedValueOnce(
      new terms.AppDeveloperTermsNotAcceptedError('pusher-refusal-marker')
    );
    const body = {
      ...pushBody({ after: NEW_SHA }),
      pusher: { login: 'dev-42', username: 'dev-42' },
    };
    const res = makeRes();
    await invoke(signedReq(body), res);
    expect(res._status).toBe(403);
    expect(vi.mocked(terms.assertAcceptedAppDeveloperTerms)).toHaveBeenCalledWith(42);
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure', description: 'pusher-refusal-marker' })
    );
    expect(mockPubReqUpdateMany).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  it('the new pending push supersedes any older pending request for the slug (one-pending-per-slug)', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(mockPubReqUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slug: SLUG, status: 'pending' }),
        data: { status: 'withdrawn' },
      })
    );
  });

  it('a re-delivery of the SAME (slug, sha) push refreshes the existing pending row instead of stacking', async () => {
    state.pendingPubReqForSha = { id: 'pubreq_existing' };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockPubReqUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pubreq_existing' } })
    );
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  // ---- the moderator-approved deploy still no-ops cleanly ------------------

  it('no-ops (no pending, no build) when the pushed sha is the approved current_version_sha', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: APPROVED_SHA })), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ deploy: 'already-approved' });
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    expect(mockAppBlockUpdate).not.toHaveBeenCalled();
  });

  it('race backstop: no-ops when an approved publish request matches the pushed sha (current_version_sha not yet stamped)', async () => {
    // Simulate the webhook racing ahead of approveRequest's current_version_sha
    // write but after it finalised the publish request for this sha.
    state.appBlock = { ...(state.appBlock as object), currentVersionSha: null } as Record<
      string,
      unknown
    >;
    state.approvedPubReqForSha = { id: 'pubreq_approved' };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ deploy: 'already-approved' });
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  // ---- preserved gates -----------------------------------------------------

  it('rejects a bad HMAC signature (401) before any DB work', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA }), 'sha256=deadbeef'), res);
    expect(res._status).toBe(401);
    expect(mockAppBlockFindFirst).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  it('rejects a push from the wrong org/repo (403) — civitai-apps-review same-slug', async () => {
    const res = makeRes();
    await invoke(
      signedReq(pushBody({ after: NEW_SHA, fullName: `civitai-apps-review/${SLUG}` })),
      res
    );
    expect(res._status).toBe(403);
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('🔴 a push to the SOURCE org (civitai-apps-src/<slug>) files nothing and builds nothing (403)', async () => {
    // Everything else about this push would park a pending request: a valid signature, `main`,
    // an approved block under the same slug, a new sha and a valid manifest (the test above shows
    // the same body under civitai-apps/ does park). Only the org differs, so the 403 is the gate's.
    const res = makeRes();
    await invoke(
      signedReq(pushBody({ after: NEW_SHA, fullName: `civitai-apps-src/${SLUG}` })),
      res
    );
    expect(res._status).toBe(403);
    expect(res._body).toEqual({
      error: 'Unexpected or missing repository org',
      fullName: `civitai-apps-src/${SLUG}`,
    });
    expect(mockGetRawFile).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('control for the source-org case: the same push under civitai-apps/ parks a pending request', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(202);
    expect(mockPubReqCreate).toHaveBeenCalledTimes(1);
  });

  it('503s when the pipeline flag is off (kill switch) before any DB work', async () => {
    state.flagEnabled = false;
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(503);
    expect(mockAppBlockFindFirst).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  it('gates on the PIPELINE flag key, not the user-facing flag (Decision 1)', async () => {
    // flag on → proceeds past the gate (reaches DB / pending-review path).
    state.flagEnabled = true;
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    // Proceeded past the gate (no 503).
    expect(res._status).not.toBe(503);
    expect(mockAppBlockFindFirst).toHaveBeenCalled();
    // Evaluated the dedicated pipeline key, never the user-facing one.
    expect(mockedIsFlipt).toHaveBeenCalledWith('app-blocks-pipeline-enabled');
    expect(mockedIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
    expect(mockedIsFlipt).not.toHaveBeenCalledWith('app-blocks-enabled');
  });

  it('rejects an invalid manifest (400) — no pending row, no build (manifest validation preserved)', async () => {
    state.validation = { valid: false, errors: ['scopes: forbidden'] };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(400);
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('🔴 refuses a pushed permission hook (400 + storageHookErrors), parks nothing and pings no one', async () => {
    // The manifest validator is stubbed valid here, so the refusal is the push-path hook pin's:
    // the hooks storage feature ships off, so the declaration is not available yet.
    state.manifest = {
      ...validManifest(NEW_SHA),
      storage: {
        collections: {
          cards: {
            visibility: 'private',
            hook: { file: 'hooks/cards.js', sha256: 'a'.repeat(64) },
          },
        },
      },
    };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(400);
    expect(res._body).toEqual({
      error: 'Storage hook refused',
      storageHookErrors: [{ collection: 'cards', file: 'hooks/cards.js', reason: 'not_available' }],
    });
    expect(mockSetCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure', context: 'civitai/manifest-validation' })
    );
    expect(mockPubReqUpdateMany).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores non-main branch pushes (200 skipped)', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA, ref: 'refs/heads/dev' })), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ skipped: 'non-main branch' });
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  // ---- iframe.src: pushes WITH and WITHOUT the key ------------------------
  // INVARIANT GUARDS (the behaviour predates this change): the webhook stamps the canonical
  // iframe.src onto the parsed manifest before validating, so a developer tree with no
  // `iframe.src`, with the canonical one, or with a wrong one is treated identically. These pin
  // that before any change stops the platform writing the key into the repository: a tree a
  // developer edits after `civitai app pull` may arrive either way.

  /** The manifest the validator was handed for the last push. */
  const validatedManifest = () =>
    (mockValidate.mock.calls.at(-1) as unknown[] | undefined)?.[0] as
      | { iframe?: Record<string, unknown> }
      | undefined;

  it.each([
    ['without iframe.src', { minHeight: 300 }],
    ['with the canonical iframe.src', { src: `https://${SLUG}.civit.ai/`, minHeight: 300 }],
    ['with a wrong iframe.src', { src: 'https://evil.example/', minHeight: 300 }],
  ])('a push %s parks a pending review with the canonical src validated', async (_n, iframe) => {
    state.manifest = { ...validManifest(NEW_SHA), iframe };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(202);
    expect(mockPubReqCreate).toHaveBeenCalledTimes(1);
    expect(validatedManifest()?.iframe).toEqual({
      src: `https://${SLUG}.civit.ai/`,
      minHeight: 300,
    });
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });

  it('a push with NO iframe object at all gets one with the canonical src', async () => {
    const { iframe: _drop, ...rest } = validManifest(NEW_SHA);
    state.manifest = rest;
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(202);
    expect(validatedManifest()?.iframe).toEqual({ src: `https://${SLUG}.civit.ai/` });
  });

  it.each([
    ['without iframe.src', { minHeight: 300 }],
    ['with the canonical iframe.src', { src: `https://${SLUG}.civit.ai/`, minHeight: 300 }],
  ])('the approved sha %s no-ops BEFORE the manifest is fetched', async (_n, iframe) => {
    state.manifest = { ...validManifest(APPROVED_SHA), iframe };
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: APPROVED_SHA })), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ deploy: 'already-approved' });
    expect(mockGetRawFile).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a JSON array', '[]'],
    ['not JSON', '{nope'],
  ])('a manifest that is %s is still refused (400), nothing parked', async (_n, raw) => {
    mockGetRawFile.mockResolvedValueOnce(raw);
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA })), res);
    expect(res._status).toBe(400);
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  // The approve path now creates `v<version>` / `approved-<id>` tags through the API, and a tag
  // creation is delivered to this webhook as a push to `refs/tags/...`. It must be skipped like
  // any non-main ref: it is not a code change and must never park a review request.
  it('invariant guard: a tag push (refs/tags/v1.0.0) is skipped, nothing parked or fetched', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA, ref: 'refs/tags/v1.0.0' })), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ skipped: 'non-main branch', ref: 'refs/tags/v1.0.0' });
    expect(mockGetRawFile).not.toHaveBeenCalled();
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });
});

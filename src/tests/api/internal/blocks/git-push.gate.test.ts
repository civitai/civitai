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
  state,
} = vi.hoisted(() => {
  const state = {
    flagEnabled: true,
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
  };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { FORGEJO_WEBHOOK_SECRET: SECRET, APPS_DOMAIN: 'civit.ai' } as Record<string, unknown>,
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
    flag === 'app-blocks-pipeline-enabled' ? mockFlag.enabled : false
  ),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    appBlock: { findFirst: mockAppBlockFindFirst, findUnique: mockAppBlockFindUnique },
    appBlockPublishRequest: { findFirst: mockPubReqFindFirst },
  },
  dbWrite: {
    appBlock: { update: mockAppBlockUpdate },
    appBlockPublishRequest: {
      findFirst: mockPubReqFindFirst,
      create: mockPubReqCreate,
      update: mockPubReqUpdate,
      updateMany: mockPubReqUpdateMany,
    },
  },
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: { validate: mockValidate },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  getRawFile: mockGetRawFile,
  setCommitStatus: mockSetCommitStatus,
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newUlid: mockNewUlid }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: mockTriggerBuild,
}));

import { isFlipt } from '~/server/flipt/client';

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
    state.flagEnabled = true;
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
  });

  // ---- the core fix --------------------------------------------------------

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

  it('ignores non-main branch pushes (200 skipped)', async () => {
    const res = makeRes();
    await invoke(signedReq(pushBody({ after: NEW_SHA, ref: 'refs/heads/dev' })), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ skipped: 'non-main branch' });
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });
});

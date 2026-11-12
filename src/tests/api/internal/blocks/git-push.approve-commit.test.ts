import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { buildApproveCommitMessage } from '~/server/services/blocks/approve-provenance';

/**
 * The git-push webhook must recognise approveRequest's OWN commit, whatever order the webhook and
 * approveRequest's writes land in.
 *
 * approveRequest commits the reviewed bundle, THEN stamps `app_blocks.current_version_sha` and the
 * approved publish request. Forgejo fires this webhook while the commit call is still in flight,
 * so the webhook usually runs before those writes. Both marker checks then miss, and the approve's
 * own commit used to be recorded as a second, unreviewed `pending` request for the same version.
 * The approve's supersede withdrew that row when it was written first; when the webhook wrote it
 * AFTER the supersede it stayed pending, and a moderator approved the duplicate.
 *
 * Every test here runs in that ordering: the markers are NOT written (current_version_sha is the
 * previous version's sha, no approved request has the new sha), and the request being approved
 * is still `pending` on the primary.
 */

const SECRET = 'test-forgejo-webhook-secret';
const SLUG = 'race-demo-app';
const OTHER_SLUG = 'other-demo-app';
const PREVIOUS_SHA = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';
const APPROVE_SHA = '9c8b7a6f5e4d3c2b1a0f9c8b7a6f5e4d3c2b1a0f';
const DEV_SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const APPROVING_ID = 'pubreq_01TESTAPPROVING00000000000';
const OTHER_SLUG_ID = 'pubreq_01TESTOTHERSLUG00000000000';
const WITHDRAWN_ID = 'pubreq_01TESTWITHDRAWN000000000000';
const PLATFORM_LOGIN = 'platform-bot-7q';
const APP_BLOCK_ID = 'apb_0123456789ABCDEFGHJKMNPQRS';

const {
  mockGetRawFile,
  mockSetCommitStatus,
  mockValidate,
  mockGetPlatformLogin,
  mockTriggerBuild,
  findRequest,
  state,
} = vi.hoisted(() => {
  const state = {
    appBlock: null as null | Record<string, unknown>,
    // Publish requests on the PRIMARY, by id.
    requests: [] as Array<{ id: string; slug: string; status: string }>,
  };
  // The webhook's two lookups that recordPendingFromPush and the marker backstop make
  // (status + forgejoCommitSha), and the approve-commit lookup (id + slug + status set).
  const findRequest = async ({ where }: { where: Record<string, unknown> }) => {
    if (typeof where.id !== 'string') return null; // no approved/pending row for any sha here
    // A real filter: every key the query names must match, and a key it leaves out matches
    // anything (so a query that drops a condition finds MORE rows, as Prisma would).
    const status = where.status as string | { in?: string[] } | undefined;
    const row = state.requests.find(
      (r) =>
        r.id === where.id &&
        (where.slug === undefined || r.slug === where.slug) &&
        (status === undefined ||
          (typeof status === 'string' ? r.status === status : !!status.in?.includes(r.status)))
    );
    return row ? { id: row.id } : null;
  };
  return {
    state,
    findRequest,
    mockGetRawFile: vi.fn(async () =>
      JSON.stringify({
        blockId: 'race-demo-app',
        version: '0.17.1',
        name: 'Race Demo',
        iframe: { src: 'https://race-demo-app.civit.ai/' },
      })
    ),
    mockSetCommitStatus: vi.fn(async () => undefined),
    mockValidate: vi.fn(() => ({ valid: true, errors: [] as string[] })),
    mockGetPlatformLogin: vi.fn(async () => 'platform-bot-7q'),
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
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async (flag: string) => flag === 'app-blocks-pipeline-enabled'),
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: { validate: mockValidate, validateSubmission: mockValidate },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  getRawFile: mockGetRawFile,
  setCommitStatus: mockSetCommitStatus,
  getPlatformAccountLogin: mockGetPlatformLogin,
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newUlid: vi.fn(() => '0123456789ABCDEFGHJKMN') }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: mockTriggerBuild,
}));
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

// The database is the canonical shared mock (src/__tests__/mocks/db.mock.ts), wired per test.
const mockPubReqCreate = dbMock.dbWrite.appBlockPublishRequest.create;
const mockPubReqUpdate = dbMock.dbWrite.appBlockPublishRequest.update;
const mockPubReqUpdateMany = dbMock.dbWrite.appBlockPublishRequest.updateMany;
const mockWritePubReqFindFirst = dbMock.dbWrite.appBlockPublishRequest.findFirst;

function wireDb() {
  dbMock.dbRead.appBlock.findFirst.mockImplementation(async () => state.appBlock);
  dbMock.dbRead.appBlock.findUnique.mockImplementation(async () => ({ app: { userId: 77 } }));
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockImplementation(findRequest);
  dbMock.dbRead.user.findUnique.mockImplementation(async () => ({ username: 'author' }));
  mockWritePubReqFindFirst.mockImplementation(findRequest);
  mockPubReqCreate.mockImplementation(async () => undefined);
  mockPubReqUpdate.mockImplementation(async () => undefined);
  mockPubReqUpdateMany.mockImplementation(async () => ({ count: 0 }));
  dbMock.dbWrite.appBlockPublishRequest.findMany.mockImplementation(async () => []);
}

/** The message approveRequest writes for APPROVING_ID (the real writer, so reader and writer agree). */
function approveMessage(publishRequestId = APPROVING_ID) {
  return buildApproveCommitMessage({
    publishRequestId,
    slug: SLUG,
    version: '0.17.1',
    sourceCommit: DEV_SHA,
    sourceDirty: false,
  });
}

function pushBody(opts: {
  after?: string;
  pusher?: string;
  commits?: Array<{ id: string; message: string }>;
}) {
  const after = opts.after ?? APPROVE_SHA;
  const pusher = opts.pusher ?? PLATFORM_LOGIN;
  return {
    ref: 'refs/heads/main',
    after,
    before: PREVIOUS_SHA,
    repository: { name: SLUG, full_name: `civitai-apps/${SLUG}` },
    pusher: { login: pusher, username: pusher },
    commits: opts.commits ?? [{ id: after, message: approveMessage() }],
  };
}

function signedReq(bodyObj: Record<string, unknown>): NextApiRequest {
  const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
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
    setHeader: vi.fn(),
    end: vi.fn(function (this: any) {
      return this;
    }),
  };
  return res as unknown as NextApiResponse & { _status: number; _body: any };
}

async function invoke(body: Record<string, unknown>) {
  const handler = (await import('~/pages/api/internal/blocks/git-push')).default;
  const res = makeRes();
  await handler(signedReq(body), res);
  return res;
}

/** The push went through to the review queue: recorded as a pending request for its sha. */
function expectRecordedForReview(res: { _status: number; _body: any }, sha: string) {
  expect(res._status).toBe(202);
  expect(res._body).toMatchObject({ status: 'pending-review', deployed: false });
  expect(mockPubReqCreate).toHaveBeenCalledTimes(1);
  expect(mockPubReqCreate.mock.calls[0][0].data).toMatchObject({
    slug: SLUG,
    status: 'pending',
    forgejoCommitSha: sha,
  });
}

describe("git-push webhook — the approve's own commit, before its markers are written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireDb();
    state.appBlock = {
      id: APP_BLOCK_ID,
      appId: `app-${SLUG}`,
      blockId: SLUG,
      // The PREVIOUS approved version: approveRequest has committed but not stamped yet.
      currentVersionSha: PREVIOUS_SHA,
      app: { id: `app-${SLUG}`, allowedScopes: 0, allowedOrigins: [`https://${SLUG}.civit.ai`] },
    };
    state.requests = [
      { id: APPROVING_ID, slug: SLUG, status: 'pending' },
      { id: OTHER_SLUG_ID, slug: OTHER_SLUG, status: 'pending' },
      { id: WITHDRAWN_ID, slug: SLUG, status: 'withdrawn' },
    ];
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  it('🔴 REGRESSION: the approve commit is a no-op naming the request being approved; no second request is recorded', async () => {
    const res = await invoke(pushBody({}));
    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      ok: true,
      slug: SLUG,
      sha: APPROVE_SHA,
      deploy: 'already-approved',
      publishRequestId: APPROVING_ID,
    });
    expect(mockPubReqCreate).not.toHaveBeenCalled();
    expect(mockPubReqUpdate).not.toHaveBeenCalled();
    expect(mockPubReqUpdateMany).not.toHaveBeenCalled();
    expect(mockGetRawFile).not.toHaveBeenCalled();
    expect(mockSetCommitStatus).not.toHaveBeenCalled();
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    // The lookup that decided it read the primary, by the trailer's id and this slug.
    expect(mockWritePubReqFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: APPROVING_ID, slug: SLUG, status: { in: ['pending', 'approved'] } },
      })
    );
  });

  it('the same no-op once the request reads approved (a re-delivery after the markers)', async () => {
    state.requests[0].status = 'approved';
    const res = await invoke(pushBody({}));
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ publishRequestId: APPROVING_ID });
    expect(mockPubReqCreate).not.toHaveBeenCalled();
  });

  it('the pusher name is compared case-insensitively, as Forgejo user names are', async () => {
    const res = await invoke(pushBody({ pusher: PLATFORM_LOGIN.toUpperCase() }));
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ publishRequestId: APPROVING_ID });
  });

  it('the head commit may be given only as head_commit', async () => {
    const body = {
      ...pushBody({}),
      commits: undefined,
      head_commit: { id: APPROVE_SHA, message: approveMessage() },
    };
    const res = await invoke(body);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ publishRequestId: APPROVING_ID });
  });

  // ---- anything else is still recorded for review ----------------------------------------------

  it('a developer who copies the approve message is still recorded for review (the pusher is theirs)', async () => {
    const res = await invoke(pushBody({ pusher: 'dev-42' }));
    expectRecordedForReview(res, APPROVE_SHA);
  });

  it('a push with no pusher is recorded for review', async () => {
    const body = { ...pushBody({}), pusher: undefined };
    const res = await invoke(body);
    expectRecordedForReview(res, APPROVE_SHA);
  });

  it("an approve message naming another app's request is recorded for review", async () => {
    const res = await invoke(
      pushBody({ commits: [{ id: APPROVE_SHA, message: approveMessage(OTHER_SLUG_ID) }] })
    );
    expectRecordedForReview(res, APPROVE_SHA);
  });

  it('an approve message naming a withdrawn request is recorded for review', async () => {
    const res = await invoke(
      pushBody({ commits: [{ id: APPROVE_SHA, message: approveMessage(WITHDRAWN_ID) }] })
    );
    expectRecordedForReview(res, APPROVE_SHA);
  });

  it('an approve message naming a request that does not exist is recorded for review', async () => {
    const res = await invoke(
      pushBody({
        commits: [{ id: APPROVE_SHA, message: approveMessage('pubreq_01TESTNOSUCHROW0000000000') }],
      })
    );
    expectRecordedForReview(res, APPROVE_SHA);
  });

  it('a manifest edit (the platform account, no approve message) is recorded for review, without asking Forgejo who it is', async () => {
    const res = await invoke(
      pushBody({ commits: [{ id: APPROVE_SHA, message: `Manifest update: ${SLUG} v0.17.2` }] })
    );
    expectRecordedForReview(res, APPROVE_SHA);
    expect(mockGetPlatformLogin).not.toHaveBeenCalled();
  });

  it('a developer commit pushed on top of an approve commit is recorded for review (only the head counts)', async () => {
    const res = await invoke(
      pushBody({
        after: DEV_SHA,
        pusher: PLATFORM_LOGIN,
        commits: [
          { id: APPROVE_SHA, message: approveMessage() },
          { id: DEV_SHA, message: 'tweak the header' },
        ],
      })
    );
    expectRecordedForReview(res, DEV_SHA);
  });

  it('when the platform account cannot be read, the push is recorded for review (the old behaviour)', async () => {
    mockGetPlatformLogin.mockRejectedValueOnce(new Error('Forgejo 503'));
    const res = await invoke(pushBody({}));
    expectRecordedForReview(res, APPROVE_SHA);
  });
});

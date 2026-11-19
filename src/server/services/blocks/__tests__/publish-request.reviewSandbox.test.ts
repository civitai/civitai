import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — service-layer coverage for previewRequest,
 * getReviewStatus, markReviewPreviewState, and teardownReviewForRequest.
 *
 * Verifies:
 *   - previewRequest reads the in-review repo HEAD, triggers the review build
 *     with SERVER-derived sha/host/url + the modUserId, and stamps building.
 *   - previewRequest refuses a non-pending request.
 *   - previewRequest resolves the source tree by ORIGIN: a git-push-originated
 *     request mirrors the reviewed commit into the in-review repo and builds
 *     THAT sha; a ZIP submission is unchanged; a request with neither pointer
 *     throws instead of silently building an unrelated tree.
 *   - a trigger failure flips state to preview-failed and re-throws.
 *   - getReviewStatus surfaces only preview-* states.
 *   - teardownReviewForRequest deletes review resources by the publish request,
 *     unconditionally (label selector is the safety boundary) and never throws.
 */

const {
  mockDbRead,
  mockDbWrite,
  mockGetReviewHead,
  mockTriggerReviewBuild,
  mockDeleteReviewResources,
  mockTriggerReviewUnpublish,
  mockDeleteAgentReviewResources,
  mockDeleteStagedBundle,
  mockDeprovisionReviewPreview,
  mockListRepoTreeAtRef,
  mockListRepoTree,
  mockGetBlobContent,
  mockEnsureReviewRepo,
  mockCommitFiles,
} = vi.hoisted(() => ({
  mockDbRead: {
    appBlockPublishRequest: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    // Fix #1 (onsite): withdrawRequest now probes for a reset listing to close. No reset
    // listing in these sandbox tests → findFirst returns null → the close early-returns.
    appListing: { findFirst: vi.fn(async () => null) },
    appListingModerationEvent: { findFirst: vi.fn(async () => null) },
  },
  mockDbWrite: {
    appBlockPublishRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    // previewRequest records the review run it started (the stale-run guard's key).
    appBlockBuildAttempt: { create: vi.fn(async () => ({ id: 1 })) },
    // The build-slot claim (review-autodeploy.service) runs in a transaction; its tx reads the
    // row through the same findUnique mock the test primes and writes through updateMany.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx)),
    appListing: { updateMany: vi.fn(async () => ({ count: 0 })) },
    appListingModerationEvent: { create: vi.fn(async () => ({})) },
    // AGENTIC REVIEW (P1) — teardownAgentReviewForRequest first probes findFirst
    // (cheap indexed existence gate) then flips a running report → torn-down via
    // updateMany. Default findFirst = a report exists (agent review ran).
    appReviewAgentReport: {
      findFirst: vi.fn(async () => ({ id: 'report_1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  },
  mockGetReviewHead: vi.fn(async () => 'a'.repeat(40)),
  // Push-originated preview path: reconstruct the reviewed commit's tree from
  // the developer's repo, then mirror it into the in-review repo.
  mockListRepoTreeAtRef: vi.fn(
    async () =>
      new Map<string, string>([
        ['block.manifest.json', 'blob-manifest'],
        ['index.html', 'blob-index'],
      ])
  ),
  mockGetBlobContent: vi.fn(async (_slug: string, blobSha: string) =>
    Buffer.from(blobSha === 'blob-manifest' ? '{"id":"my-app"}' : '<html></html>', 'utf8')
  ),
  // The IN-REVIEW repo's current `main` tree, as Map<path, git-blob-sha>. The
  // repeat-preview short-circuit compares the reconstructed file set against
  // this. Default = empty (nothing mirrored yet) → every existing case still
  // takes the mirror path.
  mockListRepoTree: vi.fn(async () => new Map<string, string>()),
  mockEnsureReviewRepo: vi.fn(async () => undefined),
  mockCommitFiles: vi.fn(async () => ({ sha: 'b'.repeat(40) })),
  mockTriggerReviewBuild: vi.fn(async () => ({ name: 'review-pr-1' })),
  mockDeleteReviewResources: vi.fn(async () => undefined),
  mockTriggerReviewUnpublish: vi.fn(async () => ({ name: 'my-app-review-unpub-aaaaaaaa' })),
  mockDeleteAgentReviewResources: vi.fn(async () => undefined),
  mockDeleteStagedBundle: vi.fn(async () => undefined),
  // #2831 — teardownReviewForRequest dynamically imports this to drop the
  // disposable run-for-real preview storage schema.
  mockDeprovisionReviewPreview: vi.fn(async () => undefined),
}));

const mockTx = {
  $executeRawUnsafe: vi.fn(async () => 0),
  $executeRaw: vi.fn(async () => 0),
  appBlockPublishRequest: {
    // Build slots held: none by default.
    count: vi.fn(async () => 0),
    findFirst: vi.fn(async (...args: unknown[]) =>
      (mockDbRead.appBlockPublishRequest.findUnique as (...a: unknown[]) => unknown)(...args)
    ),
    updateMany: vi.fn(async (...args: unknown[]) =>
      (mockDbWrite.appBlockPublishRequest.updateMany as (...a: unknown[]) => unknown)(...args)
    ),
  },
};

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  getReviewRepoHeadSha: mockGetReviewHead,
  listRepoTreeAtRef: mockListRepoTreeAtRef,
  listRepoTree: mockListRepoTree,
  getBlobContent: mockGetBlobContent,
  ensureReviewRepo: mockEnsureReviewRepo,
  commitFiles: mockCommitFiles,
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  getReviewRepoHeadSha: mockGetReviewHead,
  triggerReviewBuild: mockTriggerReviewBuild,
  deleteReviewResources: mockDeleteReviewResources,
  triggerReviewUnpublish: mockTriggerReviewUnpublish,
  // pure helper used by previewRequest
  reviewHost: (sha: string, domain: string) => `review-${sha.slice(0, 16)}.${domain}`,
}));
// AGENTIC REVIEW (P1) — teardownAgentReviewForRequest dynamically imports these.
vi.mock('~/server/services/blocks/agent-review.service', () => ({
  deleteAgentReviewResources: mockDeleteAgentReviewResources,
}));
vi.mock('~/utils/bundle-s3', () => ({
  deleteStagedBundle: mockDeleteStagedBundle,
}));
vi.mock('~/server/services/apps/storage-provision.service', () => ({
  AppStorageProvisioner: {
    deprovisionReviewPreview: mockDeprovisionReviewPreview,
  },
}));

import {
  previewRequest,
  getReviewStatus,
  teardownReviewForRequest,
  teardownAgentReviewForRequest,
  teardownPreview,
  listActiveReviewPreviews,
  markReviewPreviewState,
  withdrawRequest,
  parseReviewDetail,
  releaseSettledBuildSlot,
} from '~/server/services/blocks/publish-request.service';
import { MAX_CONCURRENT_REVIEW_BUILDS } from '~/server/services/blocks/review-autodeploy.service';
import { matches, type Where } from './prisma-where.fixture';
import { REVIEW_PREVIEW_MAX_AGE_MS } from '~/shared/constants/app-review-preview.constants';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const SHA = 'a'.repeat(40);
/** In-review repo HEAD (what a ZIP submission's preview builds). */
const ZIP_BUNDLE_KEY = 'app-block-bundles/deadbeef.zip';
/** The commit a git push parked for review, and the sha the mirror commit
 *  returns — deliberately DIFFERENT from the in-review HEAD (`SHA`) so a test
 *  can tell which tree was actually built. */
const PUSH_SHA = 'c'.repeat(40);
const MIRRORED_SHA = 'b'.repeat(40);

/**
 * The reconstructed fixture files' bytes, and the REAL git blob object ids for
 * those exact bytes.
 *
 * These ids were produced by `git hash-object` on files holding precisely these
 * bytes — NOT by the code under test. That is the point: the short-circuit
 * decides "unchanged" by computing `sha1("blob <len>\0" + bytes)` itself and
 * comparing against a tree listing, so a fixture generated by the same helper
 * would agree with a broken helper and prove nothing. Pinning git's own output
 * makes the test fail if the computation drifts from git's object format.
 */
const FIXTURE_MANIFEST = '{"id":"my-app"}';
const FIXTURE_INDEX = '<html></html>';
const BLOB_SHA_MANIFEST = 'f5a834afc3f3f65df3572e185e5565cecac22456';
const BLOB_SHA_INDEX = '6c70bcfe4d48d15f8a6531d6b491e65d641a377c';
/** The in-review tree that EXACTLY matches the reconstructed fixture set. */
const matchingReviewTree = () =>
  new Map<string, string>([
    ['block.manifest.json', BLOB_SHA_MANIFEST],
    ['index.html', BLOB_SHA_INDEX],
  ]);

describe('previewRequest', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockClear();
    mockGetReviewHead.mockClear();
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it('triggers a review build with server-derived sha/host/url + modUserId, stamps building', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: null,
    });
    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 99 },
    });

    expect(mockGetReviewHead).toHaveBeenCalledWith('my-app');
    expect(result.sha).toBe(SHA);
    expect(result.host).toBe(`review-${'a'.repeat(16)}.civit.ai`);
    expect(result.url).toBe(`https://review-${'a'.repeat(16)}.civit.ai/my-app`);

    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'my-app',
        sha: SHA,
        publishRequestId: PUBREQ,
        modUserId: 99,
        callbackUrl: 'https://civitai.com/api/internal/blocks/review-build-callback',
      })
    );
    // building state stamped (first updateMany call).
    const buildingCall = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data.deployState === 'preview-building'
    );
    expect(buildingCall).toBeDefined();
  });

  it('records the started review run under the name the trigger returned', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: null,
    });
    mockTriggerReviewBuild.mockResolvedValue({ name: 'app-blocks-review-my-app-aaaaaaaa-111111' });
    await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } });
    expect(mockDbWrite.appBlockBuildAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        publishRequestId: PUBREQ,
        slug: 'my-app',
        sha: SHA,
        runId: 'app-blocks-review-my-app-aaaaaaaa-111111',
        mode: 'review',
        status: 'triggered',
      }),
      select: { id: true },
    });
  });

  it('refuses a non-pending request', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      slug: 'my-app',
    });
    await expect(
      previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 1 } })
    ).rejects.toThrow(/pending/);
    expect(mockTriggerReviewBuild).not.toHaveBeenCalled();
  });

  it('flips to preview-failed and re-throws when the trigger fails', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: null,
    });
    mockTriggerReviewBuild.mockRejectedValue(new Error('receiver 500'));
    await expect(
      previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 1 } })
    ).rejects.toThrow(/could not start review build/);
    const failedCall = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data.deployState === 'preview-failed'
    );
    expect(failedCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// previewRequest source-tree resolution by ORIGIN.
//
// A pending request reaches review one of two ways and they do NOT share a
// source: a ZIP submission pushed its files into the in-review repo at submit
// time, a git push did not (its own repo at the pushed commit is the artifact).
// Reading the in-review HEAD for a push-originated request silently previews an
// OLDER ZIP submission's tree on any slug that ever had one.
// ---------------------------------------------------------------------------
describe('previewRequest source tree by origin', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    mockGetReviewHead.mockClear();
    mockListRepoTreeAtRef.mockClear();
    mockGetBlobContent.mockClear();
    mockEnsureReviewRepo.mockClear();
    mockListRepoTree.mockReset();
    // Default: the in-review repo holds nothing this version put there, so the
    // mirror must run.
    mockListRepoTree.mockResolvedValue(new Map<string, string>());
    mockCommitFiles.mockClear();
    mockCommitFiles.mockResolvedValue({ sha: MIRRORED_SHA });
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it('push-originated (empty bundleKey + a commit): mirrors THAT commit into the in-review repo and builds the mirrored sha', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: '',
      forgejoCommitSha: PUSH_SHA,
    });

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    // The reviewed commit — not a branch HEAD — is what gets reconstructed.
    expect(mockListRepoTreeAtRef).toHaveBeenCalledWith('my-app', PUSH_SHA);
    expect(mockEnsureReviewRepo).toHaveBeenCalledWith('my-app');
    const commitArg = mockCommitFiles.mock.calls[0][0] as {
      org: string;
      slug: string;
      replaceAllFiles?: boolean;
      files: Array<{ path: string; content: Buffer }>;
    };
    expect(commitArg.org).toBe('civitai-apps-review');
    expect(commitArg.slug).toBe('my-app');
    // replaceAllFiles is what stops an older submission's files surviving.
    expect(commitArg.replaceAllFiles).toBe(true);
    expect(commitArg.files.map((f) => f.path).sort()).toEqual([
      'block.manifest.json',
      'index.html',
    ]);

    // CONTENT, not just paths. The reconstructed bytes make a real round trip
    // through the bundle ZIP (build → deflate → re-read), so a mutation that
    // corrupts them — double-encoding, wrong charset, base64-of-base64 — lands
    // here and nowhere else. Asserting the path list alone would pass green.
    const byPath = new Map(commitArg.files.map((f) => [f.path, f.content]));
    expect(byPath.get('index.html')?.toString('utf8')).toBe(FIXTURE_INDEX);
    expect(byPath.get('block.manifest.json')?.toString('utf8')).toBe(FIXTURE_MANIFEST);
    // …and those bytes are what the short-circuit will hash next time.
    expect(byPath.get('index.html')).toBeInstanceOf(Buffer);

    // The stale in-review HEAD is never consulted for this origin.
    expect(mockGetReviewHead).not.toHaveBeenCalled();
    expect(result.sha).toBe(MIRRORED_SHA);
    expect(result.host).toBe(`review-${MIRRORED_SHA.slice(0, 16)}.civit.ai`);
    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-app', sha: MIRRORED_SHA })
    );
  });

  it('ZIP-originated (real bundleKey): unchanged — reads the in-review HEAD, writes nothing', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: null,
    });

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    expect(mockGetReviewHead).toHaveBeenCalledWith('my-app');
    expect(result.sha).toBe(SHA);
    expect(mockListRepoTreeAtRef).not.toHaveBeenCalled();
    expect(mockEnsureReviewRepo).not.toHaveBeenCalled();
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-app', sha: SHA })
    );
  });

  it('a ZIP row that ALSO carries a commit sha still builds the in-review HEAD (bundleKey wins)', async () => {
    // Approved-then-resubmitted slugs can carry both pointers; the bundle is the
    // origin discriminator, exactly as in approveRequest.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: PUSH_SHA,
    });

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });
    expect(result.sha).toBe(SHA);
    expect(mockCommitFiles).not.toHaveBeenCalled();
  });

  it('neither pointer: throws instead of building an unattributable tree', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: '',
      forgejoCommitSha: null,
    });

    await expect(
      previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 7 } })
    ).rejects.toThrow(/neither a bundle nor a commit/);
    expect(mockGetReviewHead).not.toHaveBeenCalled();
    expect(mockTriggerReviewBuild).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// REPEAT PREVIEW on a push-originated request — the mirror must be conditional.
//
// commitFiles does not compare content: an existing path always gets an
// `update` op, so an unguarded mirror mints a NEW commit (new sha → new preview
// host → new resource set) on every "Rebuild preview" click even when nothing
// changed, and three downstream guards assume the sha is stable across rebuilds.
// So: identical tree ⇒ no commit, reuse the existing HEAD. ANY difference, in
// EITHER direction ⇒ mirror. A short-circuit that over-fires is worse than none
// — it would serve a stale preview, the exact bug this change removes.
// ---------------------------------------------------------------------------
describe('previewRequest repeat preview (push origin, unchanged tree)', () => {
  const pushRow = {
    id: PUBREQ,
    status: 'pending',
    slug: 'my-app',
    bundleKey: '',
    forgejoCommitSha: PUSH_SHA,
  };

  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pushRow);
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    mockGetReviewHead.mockClear();
    mockEnsureReviewRepo.mockClear();
    mockListRepoTree.mockReset();
    mockCommitFiles.mockClear();
    mockCommitFiles.mockResolvedValue({ sha: MIRRORED_SHA });
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it('in-review tree already identical: does NOT commit, reuses the existing HEAD sha', async () => {
    mockListRepoTree.mockResolvedValue(matchingReviewTree());

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    // The comparison is against the IN-REVIEW repo's main, not the source repo.
    expect(mockListRepoTree).toHaveBeenCalledWith('my-app', 'main', 'civitai-apps-review');
    // No new commit ⇒ no new sha ⇒ the preview host / dedup key / cap row all
    // stay put across a rebuild.
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(mockGetReviewHead).toHaveBeenCalledWith('my-app');
    expect(result.sha).toBe(SHA);
    expect(result.host).toBe(`review-${SHA.slice(0, 16)}.civit.ai`);
    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-app', sha: SHA })
    );
  });

  it('same paths but DIFFERENT bytes at one path: mirrors', async () => {
    const tree = matchingReviewTree();
    tree.set('index.html', '0'.repeat(40)); // some other blob
    mockListRepoTree.mockResolvedValue(tree);

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    expect(result.sha).toBe(MIRRORED_SHA);
  });

  it('a file the developer ADDED (missing from the in-review repo): mirrors', async () => {
    const tree = matchingReviewTree();
    tree.delete('index.html');
    mockListRepoTree.mockResolvedValue(tree);

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    expect(result.sha).toBe(MIRRORED_SHA);
  });

  it('a file the developer REMOVED (still present in the in-review repo): mirrors so it gets deleted', async () => {
    // The asymmetric case. Every reconstructed path matches, so a one-directional
    // comparison would call this "unchanged" and leave `stale.js` being served
    // in the preview — replaceAllFiles is what deletes it, and it only runs if
    // we mirror.
    const tree = matchingReviewTree();
    tree.set('stale.js', '1'.repeat(40));
    mockListRepoTree.mockResolvedValue(tree);

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    const commitArg = mockCommitFiles.mock.calls[0][0] as { replaceAllFiles?: boolean };
    expect(commitArg.replaceAllFiles).toBe(true);
    expect(result.sha).toBe(MIRRORED_SHA);
  });

  it('tree listing fails (repo not created yet / transport error): mirrors rather than assuming unchanged', async () => {
    mockListRepoTree.mockRejectedValue(new Error('404 repo not found'));

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    expect(result.sha).toBe(MIRRORED_SHA);
  });

  it('the short-circuit never applies to a ZIP-originated request', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      ...pushRow,
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: null,
    });
    mockListRepoTree.mockResolvedValue(matchingReviewTree());

    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 7 },
    });

    // ZIP path is byte-identical to before: straight to the in-review HEAD, no
    // tree comparison, no repo write.
    expect(mockListRepoTree).not.toHaveBeenCalled();
    expect(mockEnsureReviewRepo).not.toHaveBeenCalled();
    expect(mockCommitFiles).not.toHaveBeenCalled();
    expect(result.sha).toBe(SHA);
  });
});

describe('getReviewStatus', () => {
  beforeEach(() => mockDbRead.appBlockPublishRequest.findUnique.mockReset());

  it('a preview torn down mid-build (build detail kept) reads as no preview', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: null,
      deployDetail: JSON.stringify({ sha: SHA, buildStartedAt: new Date().toISOString() }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.state).toBeNull();
    expect(r.detail).toEqual({});
  });

  it('returns the preview state + parsed detail', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: 'https://review-x.civit.ai/my-app', sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.state).toBe('preview-live');
    expect(r.detail.url).toBe('https://review-x.civit.ai/my-app');
  });

  it('returns state:null for a non-preview deploy_state (production building)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      deployState: 'building',
      deployDetail: null,
      deployUpdatedAt: null,
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.state).toBeNull();
  });

  // 14-day max age. Boundaries measured on both sides (13d23h live, 14d1h expired) and with a
  // queued row (which holds no resources) at 30d.
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  it.each([
    ['preview-live', 14 * DAY - HOUR, 'preview-live'],
    ['preview-live', 14 * DAY + HOUR, 'preview-expired'],
    ['preview-failed', 20 * DAY, 'preview-expired'],
    ['preview-queued', 30 * DAY, 'preview-queued'],
  ])('a %s row last updated %d ms ago reports %s', async (stored, ageMs, expected) => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: stored,
      deployDetail: JSON.stringify({
        url: 'https://review-x.civit.ai/my-app',
        host: 'review-x.civit.ai',
      }),
      deployUpdatedAt: new Date(Date.now() - ageMs),
    });
    // A mod id only where no mint can happen: the live case would need a signing secret.
    const modUserId = expected === 'preview-expired' ? 4242 : undefined;
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId });
    expect(r.state).toBe(expected);
    // An expired preview mints no access URL: there is nothing left to open.
    if (expected === 'preview-expired') expect(r.previewUrl).toBeUndefined();
  });

  // The clock is the BUILD's start, which precedes the resources' creation (the janitor's clock),
  // not the last state change: a preview that went live an hour ago from a build started 14d1h
  // ago has already been reaped.
  it.each([
    [14 * DAY + HOUR, 'preview-expired'],
    [14 * DAY - HOUR, 'preview-live'],
  ])(
    'a live row whose build started %d ms ago (last write 1h ago) reports %s',
    async (startedAgo, expected) => {
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
        id: PUBREQ,
        status: 'pending',
        deployState: 'preview-live',
        deployDetail: JSON.stringify({
          buildStartedAt: new Date(Date.now() - startedAgo).toISOString(),
        }),
        deployUpdatedAt: new Date(Date.now() - HOUR),
      });
      const r = await getReviewStatus({ publishRequestId: PUBREQ });
      expect(r.state).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// getReviewStatus mint surface (#2847 auth bridge): a live preview + a calling
// mod id → a FRESH mod-bound, host-bound, short-TTL `previewUrl` (?mr=<token>).
// ---------------------------------------------------------------------------
describe('getReviewStatus previewUrl mint surface', () => {
  const SECRET = 'test-nextauth-secret-cccccccccccccccccccc';
  const HOST = 'review-aaaaaaaaaaaaaaaa.civit.ai';
  const URL = `https://${HOST}/my-app`;
  const prevSecret = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    process.env.NEXTAUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = prevSecret;
  });

  it('mints a previewUrl bound to the calling mod when preview-live + modUserId supplied', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: URL, host: HOST, sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId: 4242 });
    expect(r.previewUrl).toBeDefined();
    expect(r.previewUrl!.startsWith(`${URL}?mr=`)).toBe(true);

    // The minted token verifies for THIS host + carries the calling mod id.
    const { verifyReviewAccessToken } = await import('~/server/services/blocks/review-session');
    const token = decodeURIComponent(r.previewUrl!.split('?mr=')[1]);
    expect(verifyReviewAccessToken(token, HOST, { secret: SECRET })).toEqual({
      ok: true,
      modUserId: 4242,
    });
  });

  it('does NOT mint a previewUrl when modUserId is omitted', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: URL, host: HOST, sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ });
    expect(r.previewUrl).toBeUndefined();
  });

  it('does NOT mint a previewUrl when the preview is not live (building)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-building',
      deployDetail: JSON.stringify({ url: URL, host: HOST, sha: SHA }),
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId: 4242 });
    expect(r.previewUrl).toBeUndefined();
  });

  it('does NOT mint a previewUrl when detail.host is missing', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ url: URL, sha: SHA }), // no host
      deployUpdatedAt: new Date(),
    });
    const r = await getReviewStatus({ publishRequestId: PUBREQ, modUserId: 4242 });
    expect(r.previewUrl).toBeUndefined();
  });
});

describe('teardownReviewForRequest', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDeleteReviewResources.mockClear();
    mockDeprovisionReviewPreview.mockReset();
    mockDeprovisionReviewPreview.mockResolvedValue(undefined);
  });

  // approveRequest clears the row's detail (markRequestDeployState) before it tears down, so it
  // hands over the detail it read first; without its sha the preview is never unpublished.
  it('uses the detail the caller read before changing the row (sha and serving mode)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'building',
      deployDetail: null,
    });
    await teardownReviewForRequest(PUBREQ, {
      reviewDetail: JSON.stringify({ sha: SHA, sharedServer: true }),
    });
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      sharedServer: true,
    });
  });

  it('deletes review resources by publish request (label selector is the boundary)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'building', // production value — still must tear down via selector
      deployDetail: JSON.stringify({ sha: SHA }),
    });
    await teardownReviewForRequest(PUBREQ);
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
    });
    // The disposable preview storage schema is dropped too (#2831).
    expect(mockDeprovisionReviewPreview).toHaveBeenCalledWith({ publishRequestId: PUBREQ });
  });

  it('never throws even if the delete fails', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA }),
    });
    mockDeleteReviewResources.mockRejectedValue(new Error('k8s down'));
    await expect(teardownReviewForRequest(PUBREQ)).resolves.toBeUndefined();
  });

  it('#2831 — a k8s teardown FAILURE still DROPs the preview schema (drop runs first, independently)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA }),
    });
    // The k8s delete throws — must NOT skip the schema drop.
    mockDeleteReviewResources.mockRejectedValue(new Error('k8s down'));
    await expect(teardownReviewForRequest(PUBREQ)).resolves.toBeUndefined();
    // The DROP ran regardless of the k8s failure (it runs FIRST, in its own try).
    expect(mockDeprovisionReviewPreview).toHaveBeenCalledWith({ publishRequestId: PUBREQ });
  });

  it('#2831 — drops the preview schema even when the request row has VANISHED (early return path)', async () => {
    // The row lookup returns null → the k8s teardown early-returns, but the schema
    // drop already ran before the lookup, so it is not skipped.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await teardownReviewForRequest(PUBREQ);
    expect(mockDeprovisionReviewPreview).toHaveBeenCalledWith({ publishRequestId: PUBREQ });
    expect(mockDeleteReviewResources).not.toHaveBeenCalled();
  });

  it('#2831 — a preview-drop FAILURE never throws and does not block the k8s teardown', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'my-app',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA }),
    });
    mockDeprovisionReviewPreview.mockRejectedValue(new Error('appsdb down'));
    await expect(teardownReviewForRequest(PUBREQ)).resolves.toBeUndefined();
    // The k8s teardown still ran despite the preview-drop failure.
    expect(mockDeleteReviewResources).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AGENTIC REVIEW (P1, audit #1/#2) — teardownAgentReviewForRequest is DECOUPLED
// from the sandbox-preview teardown: it always deletes the agent k8s objects,
// flips a running report row → torn-down, and cleans up the staged bundle,
// regardless of whether a sandbox preview ever ran.
// ---------------------------------------------------------------------------
describe('teardownAgentReviewForRequest', () => {
  beforeEach(() => {
    mockDeleteAgentReviewResources.mockClear();
    mockDeleteStagedBundle.mockClear();
    mockDbWrite.appReviewAgentReport.findFirst.mockClear();
    mockDbWrite.appReviewAgentReport.findFirst.mockResolvedValue({ id: 'report_1' });
    mockDbWrite.appReviewAgentReport.updateMany.mockClear();
    mockDbWrite.appReviewAgentReport.updateMany.mockResolvedValue({ count: 1 });
  });

  it('deletes agent resources, flips the running report to torn-down, and cleans the staged bundle', async () => {
    await teardownAgentReviewForRequest(PUBREQ);

    expect(mockDeleteAgentReviewResources).toHaveBeenCalledWith(
      expect.objectContaining({ publishRequestId: PUBREQ })
    );
    expect(mockDbWrite.appReviewAgentReport.updateMany).toHaveBeenCalledWith({
      where: { publishRequestId: PUBREQ, status: 'running' },
      data: { status: 'torn-down', completedAt: expect.any(Date) },
    });
    expect(mockDeleteStagedBundle).toHaveBeenCalledWith(PUBREQ);
  });

  it('skips the k8s + MinIO teardown I/O when no agent review ran for the request', async () => {
    // No report row for this request → the cheap indexed gate returns early,
    // so the live approve/reject/withdraw path pays a single indexed read, not
    // the k8s LIST+DELETE + MinIO LIST+DELETE round-trips.
    mockDbWrite.appReviewAgentReport.findFirst.mockResolvedValue(null);

    await expect(teardownAgentReviewForRequest(PUBREQ)).resolves.toBeUndefined();

    expect(mockDbWrite.appReviewAgentReport.findFirst).toHaveBeenCalledWith({
      where: { publishRequestId: PUBREQ },
      select: { id: true },
    });
    expect(mockDeleteAgentReviewResources).not.toHaveBeenCalled();
    expect(mockDbWrite.appReviewAgentReport.updateMany).not.toHaveBeenCalled();
    expect(mockDeleteStagedBundle).not.toHaveBeenCalled();
  });

  it('never throws even if a step fails (best-effort)', async () => {
    mockDbWrite.appReviewAgentReport.updateMany.mockRejectedValue(new Error('db down'));
    await expect(teardownAgentReviewForRequest(PUBREQ)).resolves.toBeUndefined();
  });
});

describe('withdrawRequest review teardown (#2831)', () => {
  const USER = 7;
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    mockDeleteReviewResources.mockClear();
    mockDeleteAgentReviewResources.mockClear();
    // A report row exists → the agent teardown gate passes (a prior test may have
    // flipped findFirst to null).
    mockDbWrite.appReviewAgentReport.findFirst.mockResolvedValue({ id: 'report_1' });
  });

  it('tears down the review env when a previewed request is self-withdrawn', async () => {
    // First findUnique = the classify-read in withdrawRequest; second = the read
    // inside teardownReviewForRequest. Both return a previewed, owned, pending row.
    mockDbRead.appBlockPublishRequest.findUnique
      .mockResolvedValueOnce({
        id: PUBREQ,
        status: 'pending',
        submittedByUserId: USER,
        deployState: 'preview-live',
      })
      .mockResolvedValueOnce({
        slug: 'my-app',
        deployState: 'preview-live',
        deployDetail: JSON.stringify({ sha: SHA }),
      });

    await withdrawRequest({ publishRequestId: PUBREQ, userId: USER });
    // teardown is fire-and-forget (void) — let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PUBREQ, status: 'pending' },
        data: { status: 'withdrawn' },
      })
    );
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
    });
  });

  it('does NOT tear down the SANDBOX when no preview was started, but STILL tears down the agent (audit #1)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      id: PUBREQ,
      status: 'pending',
      submittedByUserId: USER,
      deployState: null,
    });

    await withdrawRequest({ publishRequestId: PUBREQ, userId: USER });
    await new Promise((r) => setTimeout(r, 0));

    // Sandbox teardown is preview-gated → skipped.
    expect(mockDeleteReviewResources).not.toHaveBeenCalled();
    // Agent teardown is UNCONDITIONAL → fires even with no sandbox preview.
    expect(mockDeleteAgentReviewResources).toHaveBeenCalledWith(
      expect.objectContaining({ publishRequestId: PUBREQ })
    );
  });
});

describe('parseReviewDetail', () => {
  it('tolerates null / non-JSON', () => {
    expect(parseReviewDetail(null)).toEqual({});
    expect(parseReviewDetail('not json')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// A moderator's start and the platform BUILD cap. The cap bounds automatic
// starts (they queue); a moderator's explicit start jumps the queue and is
// admitted even with every slot held. The old cap on LIVE previews is gone.
// ---------------------------------------------------------------------------
describe('previewRequest and the build cap', () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'my-app',
      bundleKey: ZIP_BUNDLE_KEY,
      forgejoCommitSha: null,
    });
    mockDbWrite.appBlockPublishRequest.updateMany.mockClear();
    mockGetReviewHead.mockClear();
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => {
    mockTx.appBlockPublishRequest.count.mockResolvedValue(0);
    vi.clearAllMocks();
  });

  it('a moderator start is admitted with every build slot held', async () => {
    mockTx.appBlockPublishRequest.count.mockResolvedValue(MAX_CONCURRENT_REVIEW_BUILDS);
    await expect(
      previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 1 } })
    ).resolves.toBeDefined();
    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(expect.objectContaining({ modUserId: 1 }));
  });

  it('the claim takes the advisory lock and records the moderator on the building row', async () => {
    await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 5 } });
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    const claim = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls.find(
      ([arg]: any[]) => arg.data.deployState === 'preview-building'
    );
    expect(JSON.parse(claim![0].data.deployDetail)).toEqual({
      actor: 'moderator',
      modUserId: 5,
      buildStartedAt: expect.any(String),
    });
    // The build's own mark (with the sha) carries the build start the expiry clock counts from.
    const built = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls
      .map(([arg]: any[]) => arg.data)
      .find((d: any) => d.deployState === 'preview-building' && d.deployDetail.includes('"sha"'));
    const startedAt = Date.parse(JSON.parse(built.deployDetail).buildStartedAt);
    expect(Math.abs(Date.now() - startedAt)).toBeLessThan(60_000);
  });

  it('a request that stopped being pending before the claim is refused, nothing triggered', async () => {
    mockTx.appBlockPublishRequest.findFirst.mockResolvedValueOnce(null);
    await expect(
      previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 1 } })
    ).rejects.toThrow(/pending/);
    expect(mockTriggerReviewBuild).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// teardownPreview — manual, per-request, label-scoped delete + DB clear.
// ---------------------------------------------------------------------------
describe('teardownPreview', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockDbWrite.appBlockPublishRequest.update.mockReset();
    mockDbWrite.appBlockPublishRequest.update.mockResolvedValue({});
    mockDeleteReviewResources.mockReset();
    mockDeleteReviewResources.mockResolvedValue(undefined);
  });

  it('preview-live pending: deletes review resources by request + clears DB, tornDown:true', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA, host: 'h' }),
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: true });
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
    });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: PUBREQ });
    expect(updateArg.data.deployState).toBeNull();
    expect(updateArg.data.deployDetail).toBeNull();
    expect(updateArg.data.deployUpdatedAt).toBeInstanceOf(Date);
  });

  // Its build is still running: the row is no preview any more (deploy_state null) but keeps its
  // started-build detail, so it holds the build slot until the build's callback settles it; the
  // stale window still counts from its last state change, so deployUpdatedAt is not touched.
  it('preview-building pending: torn down to no preview, keeping its build detail (and so its build slot)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-building',
      deployDetail: JSON.stringify({ sha: SHA }),
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: true });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.data).toEqual({ deployState: null });
  });

  // In preview-deploying the build's callback has already run, so nothing would release a slot
  // kept here before the stale window: the row is cleared and frees its slot now.
  it('preview-deploying pending: cleared outright (its build is over), freeing its slot', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-deploying',
      deployDetail: JSON.stringify({ sha: SHA, buildStartedAt: new Date().toISOString() }),
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: true });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.data).toEqual({
      deployState: null,
      deployDetail: null,
      deployUpdatedAt: expect.any(Date),
    });
  });

  it('teardown passes the serving mode recorded on the preview detail', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-live',
      deployDetail: JSON.stringify({ sha: SHA, sharedServer: true }),
      slug: 'my-app',
    });
    await teardownPreview({ publishRequestId: PUBREQ });
    expect(mockDeleteReviewResources).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      sharedServer: true,
    });
  });

  it('non-pending / non-preview state: no-op, tornDown:false (no delete, no DB clear)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      deployState: 'building', // production value, not a preview-*
      deployDetail: null,
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: false });
    expect(mockDeleteReviewResources).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('best-effort: k8s delete throwing still clears the DB + returns tornDown:true', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-building',
      deployDetail: JSON.stringify({ sha: SHA }),
      slug: 'my-app',
    });
    mockDeleteReviewResources.mockRejectedValue(new Error('k8s down'));
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res.tornDown).toBe(true);
    expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalled();
  });

  it('preview-failed pending: dismissable — clears the DB back to null, tornDown:true', async () => {
    // The "Dismiss failed preview" UI path: a preview-failed row is still a
    // preview-* state, so teardownPreview clears it → getReviewStatus returns
    // state:null → the panel reverts to "Start preview" (not stuck on failed).
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      deployState: 'preview-failed',
      deployDetail: JSON.stringify({ sha: SHA, error: 'review build failed' }),
      slug: 'my-app',
    });
    const res = await teardownPreview({ publishRequestId: PUBREQ });
    expect(res).toEqual({ publishRequestId: PUBREQ, tornDown: true });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.data.deployState).toBeNull();
    expect(updateArg.data.deployDetail).toBeNull();
  });

  it('throws when the request is not found', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(teardownPreview({ publishRequestId: PUBREQ })).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// markReviewPreviewState — the stale-watcher sha guard (#2831 reachability arc).
// The reachability wait can keep an apply watcher alive for minutes, so a mod
// can tear down preview A mid-wait and re-preview a new build B within the
// window. The watcher's advancing writes pass `expectedSha` so a superseded
// watcher can't clobber the newer preview's row.
// ---------------------------------------------------------------------------
describe('markReviewPreviewState (stale-watcher sha guard)', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  beforeEach(() => {
    mockDbWrite.appBlockPublishRequest.updateMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  });

  it('adds the sha guard (deployDetail contains the serialized sha) when expectedSha is set', async () => {
    await markReviewPreviewState(
      PUBREQ,
      'preview-live',
      { sha: SHA_A, host: 'h', url: 'u' },
      { requireActivePreview: true, expectedSha: SHA_A }
    );
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: PUBREQ,
          status: 'pending',
          deployState: { startsWith: 'preview-' },
          deployDetail: { contains: `"sha":"${SHA_A}"` },
        }),
      })
    );
  });

  it('the initial (building) write carries NO sha guard and NO active-preview guard', async () => {
    // previewRequest is ESTABLISHING the new preview — its sha isn't on the row
    // yet, so requiring it would deadlock the first transition.
    await markReviewPreviewState(PUBREQ, 'preview-building', { sha: SHA_A, host: 'h', url: 'u' });
    const [arg] = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls[0] as any[];
    expect(arg.where).not.toHaveProperty('deployDetail');
    expect(arg.where).not.toHaveProperty('deployState');
  });

  it('a superseded watcher (sha A) does NOT clobber the newer active preview (sha B)', async () => {
    // Play the DB: the row's CURRENT detail belongs to build B. An updateMany
    // changes the row only when the where-clause's sha fragment is actually a
    // substring of B's stored detail (which is exactly what Postgres LIKE does).
    const storedDetailForB = JSON.stringify({
      sha: SHA_B,
      host: 'review-bbbbbbbbbbbbbbbb.civit.ai',
    });
    let rowsChanged = 0;
    mockDbWrite.appBlockPublishRequest.updateMany.mockImplementation(async ({ where }: any) => {
      const frag = where?.deployDetail?.contains as string | undefined;
      // requireActivePreview is satisfied (B is a preview-* state); the sha
      // fragment is the discriminator. No fragment (guard dropped) → matches.
      const matches = frag == null || storedDetailForB.includes(frag);
      const count = matches ? 1 : 0;
      rowsChanged += count;
      return { count };
    });

    // Stale watcher A advances toward preview-live for its OWN sha (A).
    await markReviewPreviewState(
      PUBREQ,
      'preview-live',
      { sha: SHA_A, host: 'hA', url: 'uA' },
      { requireActivePreview: true, expectedSha: SHA_A }
    );

    // B's row is untouched — the guard fragment for A is absent from B's detail,
    // so watcher A changed 0 rows. (If the expectedSha guard were dropped, the
    // where-clause would carry no sha fragment, `matches` would be true, and this
    // would be 1 → the test fails, proving the guard is load-bearing.)
    expect(rowsChanged).toBe(0);
  });

  it('the OWNING watcher (sha B) still advances the row it owns', async () => {
    const storedDetailForB = JSON.stringify({
      sha: SHA_B,
      host: 'review-bbbbbbbbbbbbbbbb.civit.ai',
    });
    let rowsChanged = 0;
    mockDbWrite.appBlockPublishRequest.updateMany.mockImplementation(async ({ where }: any) => {
      const frag = where?.deployDetail?.contains as string | undefined;
      const matches = frag == null || storedDetailForB.includes(frag);
      const count = matches ? 1 : 0;
      rowsChanged += count;
      return { count };
    });
    await markReviewPreviewState(
      PUBREQ,
      'preview-live',
      { sha: SHA_B, host: 'hB', url: 'uB' },
      { requireActivePreview: true, expectedSha: SHA_B }
    );
    expect(rowsChanged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listActiveReviewPreviews — the global panel's feed (cap + active rows).
// ---------------------------------------------------------------------------
describe('listActiveReviewPreviews', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
  });

  it('returns cap + mapped active rows (host from detail), querying oldest-first', async () => {
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'a',
        slug: 's1',
        version: '1.0.0',
        deployState: 'preview-live',
        deployDetail: JSON.stringify({ host: 'review-a.civit.ai', sha: SHA }),
        deployUpdatedAt: older,
      },
      {
        id: 'b',
        slug: 's2',
        version: '2.0.0',
        deployState: 'preview-building',
        deployDetail: null,
        deployUpdatedAt: newer,
      },
    ]);

    mockDbRead.appBlockPublishRequest.count.mockResolvedValueOnce(1);
    const res = await listActiveReviewPreviews();
    expect(res.cap).toBe(MAX_CONCURRENT_REVIEW_BUILDS);
    expect(res.building).toBe(1);
    expect(res.active).toEqual([
      {
        publishRequestId: 'a',
        slug: 's1',
        version: '1.0.0',
        state: 'preview-live',
        host: 'review-a.civit.ai',
        updatedAt: older,
      },
      {
        publishRequestId: 'b',
        slug: 's2',
        version: '2.0.0',
        state: 'preview-building',
        host: null,
        updatedAt: newer,
      },
    ]);

    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('pending');
    // A queued preview is listed however old (it never expires); the others only within the
    // coarse 14-day cutoff, the same rule as isReviewPreviewExpired.
    const [queuedArm, activeArm] = arg.where.OR;
    expect(queuedArm).toEqual({ deployState: 'preview-queued' });
    expect(activeArm.deployState).toEqual({
      in: ['preview-building', 'preview-deploying', 'preview-live'],
    });
    const cutoff: Date = activeArm.deployUpdatedAt.gt;
    expect(Math.abs(cutoff.getTime() - (Date.now() - REVIEW_PREVIEW_MAX_AGE_MS))).toBeLessThan(
      5000
    );
    expect(arg.orderBy).toEqual({ deployUpdatedAt: 'asc' });
  });

  it('keeps a queued preview listed after 14 days', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'old-queued',
        slug: 's1',
        version: '1.0.0',
        deployState: 'preview-queued',
        deployDetail: JSON.stringify({ actor: 'system' }),
        deployUpdatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    ]);
    const res = await listActiveReviewPreviews();
    expect(res.active.map((p) => p.publishRequestId)).toEqual(['old-queued']);
  });

  it('leaves out a preview whose BUILD started past the max age, though its last write is recent', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'old-build',
        slug: 's1',
        version: '1.0.0',
        deployState: 'preview-live',
        deployDetail: JSON.stringify({
          buildStartedAt: new Date(Date.now() - REVIEW_PREVIEW_MAX_AGE_MS - 60_000).toISOString(),
        }),
        deployUpdatedAt: new Date(),
      },
    ]);
    const res = await listActiveReviewPreviews();
    expect(res.active).toEqual([]);
  });

  it('returns an empty active list + the cap when nothing is active', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const res = await listActiveReviewPreviews();
    expect(res).toEqual({ cap: MAX_CONCURRENT_REVIEW_BUILDS, building: 0, active: [] });
  });
});

describe('markReviewPreviewState requireActivePreview guard', () => {
  beforeEach(() => {
    mockDbWrite.appBlockPublishRequest.updateMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  });

  it('requireActivePreview=true adds a deployState preview-* filter (no resurrection of a torn-down row)', async () => {
    await markReviewPreviewState(
      PUBREQ,
      'preview-live',
      { sha: SHA },
      { requireActivePreview: true }
    );
    const arg = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls[0][0];
    expect(arg.where.id).toBe(PUBREQ);
    expect(arg.where.status).toBe('pending');
    // The load-bearing guard: a torn-down row (deployState=null, even while its build still runs
    // and its detail is kept) is not a preview-* state, so a late build callback can't resurrect it.
    expect(arg.where.deployState).toEqual({ startsWith: 'preview-' });
  });

  it('without the opt (initial preview-building mark) does NOT constrain deployState', async () => {
    await markReviewPreviewState(PUBREQ, 'preview-building', { sha: SHA });
    const arg = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls[0][0];
    expect(arg.where.id).toBe(PUBREQ);
    expect(arg.where.status).toBe('pending');
    // Initial mark transitions from null / preview-failed → preview-building, so
    // it must NOT require an existing preview-* state.
    expect(arg.where.deployState).toBeUndefined();
  });
});

describe('releaseSettledBuildSlot', () => {
  const STARTED = '2026-11-09T10:00:00.000Z';
  const LATER = '2026-11-09T10:05:00.000Z';
  const NEWER_SHA = 'c'.repeat(40);
  const detail = (sha: string, buildStartedAt: string) =>
    JSON.stringify({ modUserId: 7, sha, buildStartedAt });
  type Row = {
    id: string;
    status: string;
    deployState: string | null;
    deployDetail: string | null;
    deployUpdatedAt: Date | null;
  };
  let rows: Row[] = [];
  const row = (over: Partial<Row>): Row => ({
    id: PUBREQ,
    status: 'withdrawn',
    deployState: 'preview-building',
    deployDetail: detail(SHA, STARTED),
    deployUpdatedAt: null,
    ...over,
  });
  const released = (r: Row) => r.deployState === null && r.deployDetail === null;

  // The real `where` runs against rows (the same reading of it the review-autodeploy tests use),
  // so these pin which rows it hits, not how the object is spelled.
  beforeEach(() => {
    rows = [];
    mockDbWrite.appBlockPublishRequest.updateMany
      .mockReset()
      .mockImplementation(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      });
  });
  afterEach(() => {
    mockDbWrite.appBlockPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it.each([
    ['superseded, withdrawn or decided while its build ran', {}],
    [
      'torn down mid-build (no preview, started-build detail kept)',
      { status: 'pending', deployState: null },
    ],
  ])('releases the slot of THAT build: %s', async (_label, over) => {
    rows = [row(over)];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA, buildStartedAt: STARTED });
    expect(released(rows[0])).toBe(true);
    expect(rows[0].deployUpdatedAt).toBeInstanceOf(Date);
  });

  it('never touches an active pending preview', async () => {
    rows = [row({ status: 'pending' })];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA, buildStartedAt: STARTED });
    expect(rows[0]).toEqual(row({ status: 'pending' }));
  });

  it("an old build's watcher leaves the slot a NEWER build of the same request holds", async () => {
    rows = [row({ deployDetail: detail(NEWER_SHA, LATER) })];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA, buildStartedAt: STARTED });
    expect(rows[0]).toEqual(row({ deployDetail: detail(NEWER_SHA, LATER) }));
  });

  it('a rebuild of the same sha started later is left alone when the start time is known', async () => {
    rows = [row({ deployDetail: detail(SHA, LATER) })];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA, buildStartedAt: STARTED });
    expect(rows[0]).toEqual(row({ deployDetail: detail(SHA, LATER) }));
  });

  it('another request is never touched', async () => {
    rows = [row({ id: 'pubreq_OTHER' })];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA, buildStartedAt: STARTED });
    expect(rows[0]).toEqual(row({ id: 'pubreq_OTHER' }));
  });

  it('with only the sha known (the build callback), matches on the sha', async () => {
    rows = [row({ deployDetail: detail(SHA, LATER) })];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA });
    expect(released(rows[0])).toBe(true);
    rows = [row({ deployDetail: detail(NEWER_SHA, LATER) })];
    await releaseSettledBuildSlot(PUBREQ, { sha: SHA });
    expect(released(rows[0])).toBe(false);
  });

  it('no valid sha: releases nothing', async () => {
    rows = [row({})];
    await releaseSettledBuildSlot(PUBREQ, { sha: '' });
    expect(mockDbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(released(rows[0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REBUILD over a preview that was published to the shared static server.
//
// A rebuild (previewRequest on a row that already has a preview) claims a fresh build slot, and the
// claim REPLACES the row's deploy detail. That detail is the only record that a review-lane meta
// was published for the old sha, so if the rebuild does not unpublish it there, nothing ever does:
// the old preview stays served (behind the mod-gate) until the bucket lifecycle expires it. This is
// the state a preview-failed preview from the reachability-probe bug was left in: published, then
// marked failed, then rebuilt.
// ---------------------------------------------------------------------------
describe('previewRequest — rebuild unpublishes the replaced shared-server preview', () => {
  const OLD_SHA = 'e'.repeat(40);
  const pendingRow = (deployState: string | null, detail: Record<string, unknown> | null) => ({
    id: PUBREQ,
    status: 'pending',
    slug: 'my-app',
    bundleKey: ZIP_BUNDLE_KEY,
    forgejoCommitSha: null,
    deployState,
    deployDetail: detail ? JSON.stringify(detail) : null,
  });

  beforeEach(() => {
    process.env.NEXTAUTH_URL = 'https://civitai.com';
    mockDbRead.appBlockPublishRequest.findUnique.mockReset();
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
    mockTriggerReviewUnpublish.mockReset();
    mockTriggerReviewUnpublish.mockResolvedValue({ name: 'my-app-review-unpub-eeeeeeee' });
  });
  afterEach(() => vi.clearAllMocks());

  it.each(['preview-failed', 'preview-live', 'preview-deploying'])(
    'a rebuild over a %s shared-server preview unpublishes the OLD sha',
    async (state) => {
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRow(state, {
          sha: OLD_SHA,
          host: `review-${'e'.repeat(16)}.civit.ai`,
          sharedServer: true,
          error: 'Preview deployed but its host did not become reachable in time',
        })
      );
      await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } });
      expect(mockTriggerReviewUnpublish).toHaveBeenCalledTimes(1);
      expect(mockTriggerReviewUnpublish).toHaveBeenCalledWith({
        slug: 'my-app',
        sha: OLD_SHA,
        publishRequestId: PUBREQ,
      });
      // The replaced detail is read inside the claim's transaction (the mock returns every field
      // whatever is selected, so pin that the claim actually asks for it).
      expect(mockTx.appBlockPublishRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ deployDetail: true }) })
      );
      // ...and the rebuild itself still goes ahead.
      expect(mockTriggerReviewBuild).toHaveBeenCalledWith(
        expect.objectContaining({ publishRequestId: PUBREQ, sha: SHA })
      );
    }
  );

  it('a SAME-sha rebuild does NOT unpublish: it would delete the meta the new build is about to republish', async () => {
    // With the flag on, the new build republishes review/<sha16>/ for this same sha. An unpublish
    // Job that lands after that publish leaves the preview marked live but 404ing, and the
    // callback's replay guard means nothing republishes it.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRow('preview-failed', { sha: SHA, sharedServer: true })
    );
    await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } });
    expect(mockTriggerReviewUnpublish).not.toHaveBeenCalled();
    // Positive control: the rebuild ran and resolved the same sha.
    expect(mockTriggerReviewBuild).toHaveBeenCalledWith(expect.objectContaining({ sha: SHA }));
  });

  it('the different-sha decision is made AFTER the new sha is resolved', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRow('preview-failed', { sha: OLD_SHA, sharedServer: true })
    );
    await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } });
    expect(mockTriggerReviewUnpublish).toHaveBeenCalledTimes(1);
    expect(mockGetReviewHead.mock.invocationCallOrder[0]).toBeLessThan(
      mockTriggerReviewUnpublish.mock.invocationCallOrder[0]
    );
  });

  it('a rebuild whose source cannot be resolved still unpublishes the replaced preview (its detail is gone)', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRow('preview-failed', { sha: OLD_SHA, sharedServer: true })
    );
    mockGetReviewHead.mockRejectedValueOnce(new Error('forgejo down'));
    await expect(
      previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } })
    ).rejects.toThrow(/forgejo down/);
    expect(mockTriggerReviewUnpublish).toHaveBeenCalledWith({
      slug: 'my-app',
      sha: OLD_SHA,
      publishRequestId: PUBREQ,
    });
  });

  it.each([
    ['a per-preview preview (sharedServer false)', { sha: OLD_SHA, sharedServer: false }],
    ['a preview whose serving mode was never recorded', { sha: OLD_SHA }],
    ['a shared-server detail with no sha', { sharedServer: true }],
    ['a shared-server detail with a malformed sha', { sha: 'nope', sharedServer: true }],
  ])('no unpublish for %s', async (_label, detail) => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRow('preview-failed', detail)
    );
    await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } });
    expect(mockTriggerReviewUnpublish).not.toHaveBeenCalled();
    // Positive control: the rebuild ran, so the zero above is not a rebuild that never started.
    expect(mockTriggerReviewBuild).toHaveBeenCalledTimes(1);
  });

  it('a first start (no prior preview) unpublishes nothing', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRow(null, null));
    await previewRequest({ publishRequestId: PUBREQ, actor: { kind: 'moderator', userId: 99 } });
    expect(mockTriggerReviewUnpublish).not.toHaveBeenCalled();
    expect(mockTriggerReviewBuild).toHaveBeenCalledTimes(1);
  });

  it('a failing unpublish does not block the rebuild', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRow('preview-failed', { sha: OLD_SHA, sharedServer: true })
    );
    mockTriggerReviewUnpublish.mockRejectedValue(new Error('k8s down'));
    const result = await previewRequest({
      publishRequestId: PUBREQ,
      actor: { kind: 'moderator', userId: 99 },
    });
    expect(mockTriggerReviewUnpublish).toHaveBeenCalledTimes(1);
    expect(result.sha).toBe(SHA);
    expect(mockTriggerReviewBuild).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

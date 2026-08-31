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
    appBlockPublishRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
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
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
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
  mockDeleteAgentReviewResources: vi.fn(async () => undefined),
  mockDeleteStagedBundle: vi.fn(async () => undefined),
  // #2831 — teardownReviewForRequest dynamically imports this to drop the
  // disposable run-for-real preview storage schema.
  mockDeprovisionReviewPreview: vi.fn(async () => undefined),
}));

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
  countActiveReviewPreviews,
  listActiveReviewPreviews,
  markReviewPreviewState,
  withdrawRequest,
  parseReviewDetail,
  MAX_CONCURRENT_REVIEW_PREVIEWS,
  REVIEW_PREVIEW_TTL_MS,
} from '~/server/services/blocks/publish-request.service';

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
    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 99 });

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

  it('refuses a non-pending request', async () => {
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'approved',
      slug: 'my-app',
    });
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      /pending/
    );
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
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      /could not start review build/
    );
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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });
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

    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 7 })).rejects.toThrow(
      /neither a bundle nor a commit/
    );
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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    expect(result.sha).toBe(MIRRORED_SHA);
  });

  it('a file the developer ADDED (missing from the in-review repo): mirrors', async () => {
    const tree = matchingReviewTree();
    tree.delete('index.html');
    mockListRepoTree.mockResolvedValue(tree);

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

    expect(mockCommitFiles).toHaveBeenCalledTimes(1);
    const commitArg = mockCommitFiles.mock.calls[0][0] as { replaceAllFiles?: boolean };
    expect(commitArg.replaceAllFiles).toBe(true);
    expect(result.sha).toBe(MIRRORED_SHA);
  });

  it('tree listing fails (repo not created yet / transport error): mirrors rather than assuming unchanged', async () => {
    mockListRepoTree.mockRejectedValue(new Error('404 repo not found'));

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

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

    const result = await previewRequest({ publishRequestId: PUBREQ, modUserId: 7 });

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
    const { verifyReviewAccessToken } = await import(
      '~/server/services/blocks/review-session'
    );
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
      expect.objectContaining({ where: { id: PUBREQ, status: 'pending' }, data: { status: 'withdrawn' } })
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
// Concurrency cap — countActiveReviewPreviews builds the ACTIVE predicate
// (pending + preview-building/deploying/live + within the TTL window). The DB
// filtering is mocked away, so we assert the WHERE clause carries the exact
// predicate (that's what excludes failed/null/expired/non-pending in prod) and
// that the count is the returned row count.
// ---------------------------------------------------------------------------
describe('countActiveReviewPreviews', () => {
  beforeEach(() => {
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
  });

  it('queries pending + active preview-* states within the TTL window, oldest-first', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      { id: 'a', slug: 's1', version: '1.0.0', deployState: 'preview-live', deployDetail: null, deployUpdatedAt: new Date() },
      { id: 'b', slug: 's2', version: '1.0.0', deployState: 'preview-building', deployDetail: null, deployUpdatedAt: new Date() },
    ]);
    const before = Date.now();
    const count = await countActiveReviewPreviews();
    expect(count).toBe(2);

    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('pending');
    expect(arg.where.deployState).toEqual({
      in: ['preview-building', 'preview-deploying', 'preview-live'],
    });
    // TTL cutoff ≈ now - REVIEW_PREVIEW_TTL_MS (excludes rows older than 6h).
    const cutoff: Date = arg.where.deployUpdatedAt.gt;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - REVIEW_PREVIEW_TTL_MS + 5000);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - REVIEW_PREVIEW_TTL_MS - 5000);
    // oldest-first — the natural teardown order.
    expect(arg.orderBy).toEqual({ deployUpdatedAt: 'asc' });
    // no exclusion by default.
    expect(arg.where.id).toBeUndefined();
  });

  it('respects excludePublishRequestId (so a rebuild never counts itself)', async () => {
    await countActiveReviewPreviews({ excludePublishRequestId: PUBREQ });
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.id).toEqual({ not: PUBREQ });
  });
});

// ---------------------------------------------------------------------------
// previewRequest cap enforcement — blocks a fresh request when MAX others are
// active; allows a rebuild of an already-active request (self excluded).
// ---------------------------------------------------------------------------
describe('previewRequest concurrency cap', () => {
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
    mockDbRead.appBlockPublishRequest.findMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockClear();
    mockGetReviewHead.mockClear();
    mockTriggerReviewBuild.mockReset();
    mockTriggerReviewBuild.mockResolvedValue({ name: 'review-pr-1' });
  });
  afterEach(() => vi.clearAllMocks());

  it('throws (naming the cap + active slugs) when MAX others are active', async () => {
    const others = Array.from({ length: MAX_CONCURRENT_REVIEW_PREVIEWS }, (_, i) => ({
      id: `other-${i}`,
      slug: `other-app-${i}`,
      version: '1.0.0',
      deployState: 'preview-live',
      deployDetail: null,
      deployUpdatedAt: new Date(),
    }));
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(others);

    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      new RegExp(`cap reached \\(${MAX_CONCURRENT_REVIEW_PREVIEWS}/${MAX_CONCURRENT_REVIEW_PREVIEWS} active\\)`)
    );
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).rejects.toThrow(
      /other-app-0/
    );
    // The cap query excluded THIS request.
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.where.id).toEqual({ not: PUBREQ });
    expect(mockTriggerReviewBuild).not.toHaveBeenCalled();
  });

  it('allows a rebuild of an already-active request when MAX total active (self excluded → 4 others)', async () => {
    // Self is one of the 5 active, so the exclude-self query returns 4 others.
    const others = Array.from({ length: MAX_CONCURRENT_REVIEW_PREVIEWS - 1 }, (_, i) => ({
      id: `other-${i}`,
      slug: `other-app-${i}`,
      version: '1.0.0',
      deployState: 'preview-live',
      deployDetail: null,
      deployUpdatedAt: new Date(),
    }));
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue(others);

    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).resolves.toBeDefined();
    expect(mockTriggerReviewBuild).toHaveBeenCalled();
  });

  it('proceeds under the cap', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      { id: 'x', slug: 'x', version: '1.0.0', deployState: 'preview-live', deployDetail: null, deployUpdatedAt: new Date() },
    ]);
    await expect(previewRequest({ publishRequestId: PUBREQ, modUserId: 1 })).resolves.toBeDefined();
    expect(mockTriggerReviewBuild).toHaveBeenCalled();
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
    const storedDetailForB = JSON.stringify({ sha: SHA_B, host: 'review-bbbbbbbbbbbbbbbb.civit.ai' });
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
    const storedDetailForB = JSON.stringify({ sha: SHA_B, host: 'review-bbbbbbbbbbbbbbbb.civit.ai' });
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

    const res = await listActiveReviewPreviews();
    expect(res.cap).toBe(MAX_CONCURRENT_REVIEW_PREVIEWS);
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
    expect(arg.where.deployState).toEqual({
      in: ['preview-building', 'preview-deploying', 'preview-live'],
    });
    expect(arg.orderBy).toEqual({ deployUpdatedAt: 'asc' });
  });

  it('returns an empty active list + the cap when nothing is active', async () => {
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const res = await listActiveReviewPreviews();
    expect(res).toEqual({ cap: MAX_CONCURRENT_REVIEW_PREVIEWS, active: [] });
  });
});

describe('markReviewPreviewState requireActivePreview guard', () => {
  beforeEach(() => {
    mockDbWrite.appBlockPublishRequest.updateMany.mockReset();
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  });

  it('requireActivePreview=true adds a deployState preview-* filter (no resurrection of a torn-down row)', async () => {
    await markReviewPreviewState(PUBREQ, 'preview-live', { sha: SHA }, { requireActivePreview: true });
    const arg = mockDbWrite.appBlockPublishRequest.updateMany.mock.calls[0][0];
    expect(arg.where.id).toBe(PUBREQ);
    expect(arg.where.status).toBe('pending');
    // The load-bearing guard: a torn-down row (deployState=null) won't match
    // startsWith 'preview-', so a late build callback can't resurrect it.
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

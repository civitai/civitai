import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
// Submit-time deep manifest validation is pinned in publish-request.submitValidation.test.ts;
// this file's fixtures are not full manifests, so that seam is a no-op here (approve's own
// validator is untouched).
vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));
import JSZip from 'jszip';
import {
  computeBundleLineDiff,
  computeFileDiff,
  computeManifestDiff,
  extractBundleMetadata,
  submitVersion,
  type FileMeta,
} from '../publish-request.service';
import {
  MAX_FILES_IN_BUNDLE,
  MAX_FILE_SIZE_BYTES,
} from '~/server/schema/blocks/publish-request.schema';
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

// submitVersion dynamically imports these; mock them so the sensitive-scope
// gate can be exercised end-to-end without a real DB / MinIO / Forgejo. The
// gate itself runs BEFORE any of these are touched (fail-fast), so the
// rejection test never reaches them; the "accepts" tests drive the full
// happy-path insert through the mocks.
const dbMocks = vi.hoisted(() => ({
  createPublishRequest: vi.fn(),
  pubReqFindFirst: vi.fn(),
  appBlockFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  // W13 draft-at-submit — the pre-approval draft AppListing pre-check (read) + create (write).
  appListingFindFirst: vi.fn(),
  appListingCreate: vi.fn(),
  // The cross-queue submit guard: `one_pending_per_slug` is partial-unique on
  // AppBlockPublishRequest only, so submitVersion also asks whether a NON-SHADOW
  // listing review is open for the slug. Null = no listing review, the shape every
  // test in this file assumes.
  listingReqFindFirst: vi.fn(async () => null),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    appBlockPublishRequest: { findFirst: dbMocks.pubReqFindFirst },
    appBlock: { findFirst: dbMocks.appBlockFindFirst },
    appListing: { findFirst: dbMocks.appListingFindFirst, findUnique: async () => null },
    appListingPublishRequest: { findFirst: dbMocks.listingReqFindFirst },
    user: { findUnique: dbMocks.userFindUnique },
  },
  dbWrite: {
    appBlockPublishRequest: {
      create: dbMocks.createPublishRequest,
      // The storage-migration history (`loadStorageMigrationBaseline`, on the PRIMARY): none.
      findMany: async () => [],
    },
    appListing: { create: dbMocks.appListingCreate },
    // The enforced manifest (`loadStorageMigrationBaseline`, on the PRIMARY): none.
    appBlock: { findFirst: async () => null },
  },
}));

vi.mock('~/env/server', () => ({
  env: { APPS_DOMAIN: 'civit.ai' },
}));

vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'test-bucket',
  getBundleS3Client: () => ({ send: vi.fn().mockResolvedValue({}) }),
}));

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Deterministic-input coverage for the W1 publish-request flow's diff
 * computations and bundle parsing. These tests don't touch MinIO or the
 * DB; the integration coverage of the full submitVersion pipeline lives
 * in a Phase 2 follow-on (needs an S3 mock).
 */

function makeFile(path: string, sha: string, size = 100): FileMeta {
  return { path, sha256: sha, sizeBytes: size };
}

describe('computeFileDiff', () => {
  it('handles a mix of add/remove/change in one diff', () => {
    const prev = [makeFile('Dockerfile', '1'), makeFile('old.tsx', '2')];
    const curr = [makeFile('Dockerfile', '1-changed'), makeFile('new.tsx', '3')];
    const result = computeFileDiff(curr, prev);
    expect(result.added).toEqual(['new.tsx']);
    expect(result.removed).toEqual(['old.tsx']);
    expect(result.changed).toEqual(['Dockerfile']);
  });
});

describe('computeManifestDiff', () => {
  const withStorage = (collections: Record<string, unknown>) => ({
    blockId: 'x',
    storage: { collections },
  });
  const sharedColl = (extra: Record<string, unknown> = {}) => ({
    visibility: 'shared',
    write: 'own',
    ...extra,
  });

  it('🔴 names the collections a version newly publishes to registries', () => {
    const prev = withStorage({ notes: sharedColl(), pins: sharedColl({ registry: 'public' }) });
    const curr = withStorage({
      notes: sharedColl({ registry: 'public' }),
      pins: sharedColl({ registry: 'public' }),
    });
    expect(computeManifestDiff(curr, prev).registryExports).toEqual({
      exported: ['notes', 'pins'],
      added: ['notes'],
      removed: [],
    });
  });

  it('detects deep object changes via stable hash (key order independence)', () => {
    const prev = { iframe: { src: 'a', minHeight: 200 } };
    const curr = { iframe: { minHeight: 200, src: 'a' } }; // same content, different key order
    const result = computeManifestDiff(curr, prev);
    if (result.kind !== 'update') throw new Error('expected update');
    expect(result.changed).toEqual([]); // semantically equal
  });
});

describe('extractBundleMetadata', () => {
  async function makeBundle(files: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(files)) {
      zip.file(path, content);
    }
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  it('parses a valid bundle and surfaces files + manifest', async () => {
    const buf = await makeBundle({
      'block.manifest.json': JSON.stringify({
        blockId: 'hello',
        version: '0.1.0',
        name: 'Hello',
      }),
      'index.html': '<!doctype html><html><body>hi</body></html>',
    });
    const { files, manifest } = await extractBundleMetadata(buf);
    expect(files.map((f) => f.path).sort()).toEqual(['block.manifest.json', 'index.html']);
    expect(manifest).toMatchObject({ blockId: 'hello', version: '0.1.0', name: 'Hello' });
  });

  it('rejects bundles without the manifest', async () => {
    const buf = await makeBundle({
      'index.html': '<!doctype html>',
    });
    await expect(extractBundleMetadata(buf)).rejects.toThrow(
      /missing required file: block.manifest.json/
    );
  });

  it('rejects when a single file exceeds 10 MiB cap', async () => {
    // One file at MAX_FILE_SIZE_BYTES + 1 = 10 MiB + 1 byte.
    const big = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 'x');
    const buf = await makeBundle({
      'block.manifest.json': '{"blockId":"x"}',
      'big.bin': big.toString('binary'),
    });
    await expect(extractBundleMetadata(buf)).rejects.toThrow(
      new RegExp(`max ${MAX_FILE_SIZE_BYTES}`)
    );
  });

  it('rejects when bundle exceeds the 2000-file cap', async () => {
    const zip = new JSZip();
    zip.file('block.manifest.json', '{"blockId":"x"}');
    for (let i = 0; i < MAX_FILES_IN_BUNDLE; i += 1) {
      zip.file(`f${i}.txt`, String(i));
    }
    // Total files = 2001 (manifest + 2000 added)
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(extractBundleMetadata(buf)).rejects.toThrow(
      new RegExp(`max ${MAX_FILES_IN_BUNDLE}`)
    );
  });

  // H-1 fix — extractBundleMetadata NOW tracks the cumulative decompressed
  // size and aborts the streaming read the instant a bundle's total exceeds
  // the cap, so a small ZIP of highly-compressible content can no longer
  // inflate past the running-aggregate ceiling. Uses an injected small cap so
  // the test ZIP stays tiny while still exercising the aggregate-abort path.
  it('guards against cumulative decompression expansion (H-1 fix)', async () => {
    // 5 MiB of zeroes per file, two files = ~10 MiB extracted.
    // Force DEFLATE so the compressed ZIP is much smaller than the
    // extracted total (default jszip behavior is STORE).
    const big = Buffer.alloc(5 * 1024 * 1024, 0);
    const zip = new JSZip();
    zip.file('block.manifest.json', '{"blockId":"x"}');
    zip.file('a.bin', big);
    zip.file('b.bin', big);
    const buf = Buffer.from(
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      })
    );
    // Compressed buffer is well under 1 MiB; extracted total is ~10 MiB.
    expect(buf.length).toBeLessThan(1 * 1024 * 1024);
    // Inject a 6 MiB total cap: the two 5 MiB files sum past it, so the
    // running-aggregate guard rejects the bundle instead of materialising it.
    await expect(extractBundleMetadata(buf, { maxTotalBytes: 6 * 1024 * 1024 })).rejects.toThrow(
      /zip bomb|decompress/i
    );
  });

  it('aggregate cap boundary: total exactly at cap passes, one byte over rejects', async () => {
    // Two 1 MiB zero-filled DEFLATE files = 2 MiB decompressed total. With a
    // 2 MiB total cap the bundle is exactly at the ceiling and must pass; with
    // a one-byte-smaller cap it must reject. The manifest's own bytes count
    // toward the total, so cap = files + manifest length for the pass case.
    const oneMiB = 1024 * 1024;
    const manifestJson = '{"blockId":"x"}';
    const filesTotal = 2 * oneMiB;
    const exactCap = filesTotal + Buffer.byteLength(manifestJson);

    async function makeZeroBundle(): Promise<Buffer> {
      const zip = new JSZip();
      zip.file('block.manifest.json', manifestJson);
      zip.file('a.bin', Buffer.alloc(oneMiB, 0));
      zip.file('b.bin', Buffer.alloc(oneMiB, 0));
      return Buffer.from(
        await zip.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        })
      );
    }

    const buf = await makeZeroBundle();
    // Exactly at the cap: passes.
    const { files } = await extractBundleMetadata(buf, { maxTotalBytes: exactCap });
    expect(files.length).toBe(3);
    // One byte under the needed budget: rejects.
    await expect(extractBundleMetadata(buf, { maxTotalBytes: exactCap - 1 })).rejects.toThrow(
      /zip bomb|decompress/i
    );
  });
});

describe('computeBundleLineDiff', () => {
  const f = (path: string, content: string | Buffer) => ({
    path,
    content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
  });

  it('produces the expected unified-diff hunk for a changed file', () => {
    const prev = [f('greet.ts', 'line1\nline2\nline3\nline4\nline5\n')];
    const curr = [f('greet.ts', 'line1\nline2\nCHANGED\nline4\nline5\n')];
    const result = computeBundleLineDiff(curr, prev);
    const file = result.files[0];
    expect(file.skipReason).toBeNull();
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    const lines = file.hunks.flatMap((h) => h.lines);
    // The removed line3 and the added CHANGED line are both present.
    expect(lines).toContain('-line3');
    expect(lines).toContain('+CHANGED');
    // Context lines are carried with a leading space.
    expect(lines).toContain(' line2');
    expect(lines).toContain(' line4');
    // Hunk geometry is well-formed.
    expect(file.hunks[0].oldStart).toBeGreaterThan(0);
    expect(file.hunks[0].newStart).toBeGreaterThan(0);
  });

  it('caps the total number of files diffed and flags truncation', () => {
    const curr = [f('a.ts', 'a\n'), f('b.ts', 'b\n'), f('c.ts', 'c\n')];
    const result = computeBundleLineDiff(curr, null, { maxFiles: 2 });
    expect(result.truncated).toBe(true);
    // First two diffed, third marked file-cap (sorted order: a, b, c).
    expect(result.files).toHaveLength(3);
    expect(result.files[0].skipReason).toBeNull();
    expect(result.files[1].skipReason).toBeNull();
    expect(result.files[2].skipReason).toBe('file-cap');
    expect(result.files[2].path).toBe('c.ts');
  });
});

describe('submitVersion — sensitive-scope justification gate (enforced AT SUBMIT)', () => {
  async function makeBundle(manifest: Record<string, unknown>): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('block.manifest.json', JSON.stringify(manifest));
    zip.file('index.html', '<!doctype html><html><body>hi</body></html>');
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  const baseManifest = { blockId: 'my-app', version: '0.1.0', name: 'My App' };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.pubReqFindFirst.mockResolvedValue(null);
    dbMocks.appBlockFindFirst.mockResolvedValue(null);
    dbMocks.userFindUnique.mockResolvedValue({ username: 'dev' });
    dbMocks.createPublishRequest.mockResolvedValue({});
    // Default: the store slug is free → a first-version submit mints the draft.
    dbMocks.appListingFindFirst.mockResolvedValue(null);
    dbMocks.appListingCreate.mockResolvedValue({ id: 'apl_draft' });
  });

  it('rejects a NEW sensitive-scope submit with NO scopeJustifications (was: accepted → pending)', async () => {
    const buf = await makeBundle({ ...baseManifest, scopes: ['ai:write:budgeted'] });
    await expect(submitVersion({ bundleBuffer: buf, submittedByUserId: 1 })).rejects.toThrow(
      'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ai:write:budgeted'
    );
    // Fail-fast: rejected before any DB insert — it never enters the mod queue.
    expect(dbMocks.createPublishRequest).not.toHaveBeenCalled();
  });

  it('names every unjustified sensitive scope in the rejection message', async () => {
    const buf = await makeBundle({
      ...baseManifest,
      scopes: ['ai:write:budgeted', 'buzz:read:self', 'models:read:self'],
    });
    await expect(submitVersion({ bundleBuffer: buf, submittedByUserId: 1 })).rejects.toThrow(
      'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ai:write:budgeted, buzz:read:self'
    );
    expect(dbMocks.createPublishRequest).not.toHaveBeenCalled();
  });

  it('accepts a sensitive-scope submit WITH a non-empty justification → pending pubreq', async () => {
    const buf = await makeBundle({
      ...baseManifest,
      scopes: ['ai:write:budgeted'],
      scopeJustifications: { 'ai:write:budgeted': 'runs the generation the user requested' },
    });
    const result = await submitVersion({ bundleBuffer: buf, submittedByUserId: 1 });
    expect(result.slug).toBe('my-app');
    expect(result.version).toBe('0.1.0');
    expect(dbMocks.createPublishRequest).toHaveBeenCalledTimes(1);
  });

  it('accepts a NON-sensitive-scope submit with no justification → pending pubreq', async () => {
    const buf = await makeBundle({ ...baseManifest, scopes: ['models:read:self'] });
    const result = await submitVersion({ bundleBuffer: buf, submittedByUserId: 1 });
    expect(result.slug).toBe('my-app');
    expect(dbMocks.createPublishRequest).toHaveBeenCalledTimes(1);
  });

  // W13 draft-at-submit — a FIRST-version submit mints the on-site store AppListing as
  // a pre-approval DRAFT (kind='onsite', status='draft', appBlockId=NULL) so the author
  // can set media while pending.
  it('creates a pre-approval DRAFT AppListing at submit (first version, owned by submitter)', async () => {
    const buf = await makeBundle({ ...baseManifest, scopes: [] });
    await submitVersion({ bundleBuffer: buf, submittedByUserId: 1 });

    expect(dbMocks.appListingCreate).toHaveBeenCalledTimes(1);
    const data = (dbMocks.appListingCreate.mock.calls[0][0] as { data: Record<string, unknown> })
      .data;
    expect(data).toMatchObject({
      kind: 'onsite',
      status: 'draft',
      appBlockId: null,
      slug: 'my-app',
      name: 'My App',
      tagline: null,
      description: null,
      category: null,
      contentRating: 'g',
      userId: 1, // the submitter owns the draft
    });
    expect(typeof data.id).toBe('string');
    expect(data.id as string).toMatch(/^apl_/);
  });

  it('does NOT create a draft on a SUBSEQUENT-version submit (an AppBlock already exists)', async () => {
    dbMocks.appBlockFindFirst.mockResolvedValue({ id: 'apb_existing', appId: 'app_1' });
    const buf = await makeBundle({ ...baseManifest, version: '0.2.0', scopes: [] });
    await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 1,
      // A moderator: the owner gate on an existing app is pinned in publish-request.orchestration.test.ts.
      submitterIsModerator: true,
    });

    expect(dbMocks.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(dbMocks.appListingCreate).not.toHaveBeenCalled();
  });

  it('re-submit does NOT duplicate — a reusable on-site orphan draft is reused, not re-created', async () => {
    // A first-version re-submit whose prior draft survived (cleanup didn't run) →
    // the pre-check finds the reusable on-site pre-approval draft and skips the create.
    dbMocks.appListingFindFirst.mockResolvedValue({
      id: 'apl_orphan',
      kind: 'onsite',
      status: 'draft',
      appBlockId: null,
      userId: 1, // owned by THIS submitter — reuse is owner-scoped
    });
    const buf = await makeBundle({ ...baseManifest, scopes: [] });
    await submitVersion({ bundleBuffer: buf, submittedByUserId: 1 });

    expect(dbMocks.createPublishRequest).toHaveBeenCalledTimes(1);
    expect(dbMocks.appListingCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 🔴 Orphan reuse is OWNER-SCOPED. An orphan draft keeps its original `userId`, and
  // the approve transition carries that `userId` forward untouched — so reusing
  // ANOTHER user's orphan would hand them ownership of THIS submitter's approved
  // listing (the asset procs gate on AppListing.userId, so they'd control its media).
  // -------------------------------------------------------------------------
  it('REFUSES to reuse an orphan draft owned by a DIFFERENT user (no cross-user listing takeover)', async () => {
    dbMocks.appListingFindFirst.mockResolvedValue({
      id: 'apl_orphan_foreign',
      kind: 'onsite',
      status: 'draft',
      appBlockId: null,
      userId: 999, // someone ELSE's abandoned draft on this slug
    });
    const buf = await makeBundle({ ...baseManifest, scopes: [] });
    // Treated as TAKEN, exactly like any other foreign listing on the slug.
    await expect(submitVersion({ bundleBuffer: buf, submittedByUserId: 1 })).rejects.toThrow(
      /already taken by another store listing/
    );
    // Fail-fast: nothing is inserted, and the foreign draft is never adopted.
    expect(dbMocks.createPublishRequest).not.toHaveBeenCalled();
    expect(dbMocks.appListingCreate).not.toHaveBeenCalled();
  });

  it('a slug already taken by a NON-reusable listing → friendly "slug taken" (before any insert)', async () => {
    dbMocks.appListingFindFirst.mockResolvedValue({
      id: 'apl_live',
      kind: 'offsite',
      status: 'approved',
      appBlockId: null,
    });
    const buf = await makeBundle({ ...baseManifest, scopes: [] });
    await expect(submitVersion({ bundleBuffer: buf, submittedByUserId: 1 })).rejects.toThrow(
      /already taken by another store listing/
    );
    // Fail-fast: neither the request nor the draft is inserted.
    expect(dbMocks.createPublishRequest).not.toHaveBeenCalled();
    expect(dbMocks.appListingCreate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // #4059 build provenance — the service must PERSIST the client's claim into
  // the publish-request row, and must not invent one when the client sent
  // nothing. Asserted against the mocked `create` call args with literal values.
  // ---------------------------------------------------------------------------
  const SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';

  function createData() {
    const call = dbMocks.createPublishRequest.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    return call.data;
  }

  it('#4059 PERSISTS sourceCommit + sourceDirty into the publish-request row', async () => {
    const buf = await makeBundle({ ...baseManifest, scopes: [] });
    await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 1,
      sourceCommit: SHA,
      sourceDirty: true,
    });

    expect(dbMocks.createPublishRequest).toHaveBeenCalledTimes(1);
    const data = createData();
    expect(data.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    expect(data.sourceDirty).toBe(true);
  });

  it('#4059 does NOT conflate sourceCommit with forgejoCommitSha', async () => {
    const buf = await makeBundle({ ...baseManifest, scopes: [] });
    await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 1,
      sourceCommit: SHA,
      sourceDirty: false,
    });

    const data = createData();
    expect(data.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    // The submit path never mints a Forgejo commit — that happens on approve. A
    // fallback between the two would show up here as the sha leaking across.
    expect(data.forgejoCommitSha).toBeUndefined();
  });
});

describe('submitVersion — consecutive hyphens in a NEW blockId', () => {
  async function makeBundle(blockId: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      'block.manifest.json',
      JSON.stringify({ blockId, version: '0.3.0', name: 'Fixture App', scopes: [] })
    );
    zip.file('index.html', '<!doctype html><html><body>hi</body></html>');
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  const SUBMITTER = 61;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.pubReqFindFirst.mockResolvedValue(null);
    dbMocks.listingReqFindFirst.mockResolvedValue(null);
    dbMocks.appBlockFindFirst.mockResolvedValue(null);
    dbMocks.createPublishRequest.mockResolvedValue({});
    dbMocks.appListingFindFirst.mockResolvedValue(null);
    dbMocks.appListingCreate.mockResolvedValue({ id: 'apl_fixture' });
  });

  it.each(['my--app', 'a---b'])('refuses a first version of %s', async (blockId) => {
    const buf = await makeBundle(blockId);
    await expect(
      submitVersion({ bundleBuffer: buf, submittedByUserId: SUBMITTER })
    ).rejects.toThrow(
      `blockId "${blockId}" must not contain consecutive hyphens ("--"): app storage treats a run of hyphens as a single separator, so it could share storage with another app. Use single hyphens.`
    );
    expect(dbMocks.createPublishRequest).not.toHaveBeenCalled();
    expect(dbMocks.appListingCreate).not.toHaveBeenCalled();
  });

  it('refuses a first version with a reserved blockId', async () => {
    const buf = await makeBundle('dev-0123456789abcdef');
    await expect(
      submitVersion({ bundleBuffer: buf, submittedByUserId: SUBMITTER })
    ).rejects.toThrow('blockId "dev-0123456789abcdef" is reserved: ids starting with "dev-"');
    expect(dbMocks.createPublishRequest).not.toHaveBeenCalled();
    expect(dbMocks.appListingCreate).not.toHaveBeenCalled();
  });

  it('accepts a new version of an EXISTING app whose blockId is now reserved', async () => {
    dbMocks.appBlockFindFirst.mockResolvedValue({ id: 'apb_legacy', appId: 'app_9' });
    const buf = await makeBundle('dev-legacy');
    const result = await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: SUBMITTER,
      // A moderator: the owner gate on an existing app is pinned in publish-request.orchestration.test.ts.
      submitterIsModerator: true,
    });
    expect(result.slug).toBe('dev-legacy');
    expect(dbMocks.createPublishRequest).toHaveBeenCalledTimes(1);
  });
});

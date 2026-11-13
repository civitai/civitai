import { createHash } from 'crypto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageConstants from '~/shared/constants/block-storage.constants';
import type * as FliptClient from '~/server/flipt/client';

/**
 * App Storage PERMISSION HOOKS — the approve re-check, through the real `approveRequest`.
 *
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR: approve shipped whatever the stored bundle (or, for a
 * push-originated request, the repo at the reviewed sha) held, so a hook file that no longer
 * matched its pinned sha256, or a reviewed file list that disagreed with the bytes, went live. At
 * origin/main every refusal below fails: approve gets past this point.
 *
 * Harness as in `listing-media-split.approve-request.test.ts` (the manifest validator is stubbed
 * valid, MinIO and Forgejo are stubbed); the `hooks` storage feature is switched on by replacing the
 * exported switch, and the submitter's cohort gate is the real one over a mocked Flipt.
 */

const h = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  zip: new Uint8Array() as Uint8Array,
  isFlipt: vi.fn(),
  getSessionUserById: vi.fn(),
  tree: new Map<string, string>(),
  blobs: new Map<string, Buffer>(),
}));

vi.mock('~/shared/constants/block-storage.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageConstants>();
  Object.assign(h.features, actual.APP_STORAGE_ENABLED_FEATURES, { hooks: true });
  return { ...actual, APP_STORAGE_ENABLED_FEATURES: h.features };
});
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: h.isFlipt,
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: h.getSessionUserById },
}));
// See listing-media-split.approve-request.test.ts: approve lazily loads a module whose body
// builds a logger off the real env.
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async (): Promise<unknown[]> => [],
  bustCacheTag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-block-notify', () => ({
  notifyAppBlockSubmitter: vi.fn(async () => undefined),
}));
vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok',
    FORGEJO_WEBHOOK_SECRET: 'sec',
    APPS_DOMAIN: 'apps.example',
    NEXTAUTH_URL: 'https://civitai.example',
  },
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: {
    validate: () => ({ valid: true, errors: [] }),
    validateSubmission: async () => ({ valid: true, errors: [] }),
  },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  commitFiles: vi.fn(async () => ({ sha: 'deadbeefsha' })),
  setCommitStatus: vi.fn(async () => undefined),
  createRepoFromTemplate: vi.fn(async () => ({ html_url: 'https://forgejo.example/x' })),
  ensurePushWebhook: vi.fn(async () => undefined),
  listRepoTreeAtRef: vi.fn(async () => h.tree),
  getBlobContent: vi.fn(async (_slug: string, blobSha: string) => {
    const blob = h.blobs.get(blobSha);
    if (!blob) throw new Error(`no blob ${blobSha}`);
    return blob;
  }),
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(async () => undefined),
}));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => ({
    send: vi.fn(async () => ({ Body: { transformToByteArray: async () => h.zip } })),
  }),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
// Publish paths here run as a developer who accepted the App Developer Terms.
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

const { approveRequest } = await import('~/server/services/blocks/publish-request.service');
const { commitFiles } = await import('~/server/services/blocks/forgejo.service');

const SLUG = 'card-hooks-7c3b';
const SUBMITTER = 9202;
const MOD = 9;
const HOOK_FILE = 'hooks/cards.js';
const HOOK_SRC = 'export default function check() { return { allow: true }; }\n';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const HOOK_SHA = sha256(HOOK_SRC);
const OTHER_SHA = 'e'.repeat(64);

const manifestPinning = (sha: string) => ({
  blockId: SLUG,
  version: '1.0.0',
  name: 'Card Hooks',
  contentRating: 'g',
  scopes: ['apps:storage'],
  storage: {
    collections: { cards: { visibility: 'private', hook: { file: HOOK_FILE, sha256: sha } } },
  },
});

async function setBundle(files: Record<string, string>) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  h.zip = await zip.generateAsync({ type: 'uint8array' });
}

/** A pending request (first version of the app). `bundleKey: ''` makes it push-originated. */
function pendingRequest(args: {
  manifest: Record<string, unknown>;
  files: { path: string; sha256: string; sizeBytes: number }[];
  bundleKey?: string;
}) {
  dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
    id: 'pubreq_hooks',
    status: 'pending',
    slug: SLUG,
    version: '1.0.0',
    manifest: structuredClone(args.manifest),
    bundleKey: args.bundleKey ?? 'bundles/hooks.zip',
    forgejoCommitSha: args.bundleKey === '' ? 'abc123' : null,
    submittedByUserId: SUBMITTER,
    appBlockId: null,
    fileSummary: { files: args.files, added: [], removed: [], changed: [] },
    deployState: null,
  });
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error & { problems?: unknown }
  );

const approve = () => approveRequest({ publishRequestId: 'pubreq_hooks', reviewerUserId: MOD });

const sourceInserts = () =>
  (dbMock.dbWrite.$executeRaw.mock.calls as unknown[][])
    .filter(([strings]) => (strings as string[]).join('?').includes('app_storage_hook_sources'))
    .map(([, shas]) => shas);

beforeEach(() => {
  vi.clearAllMocks();
  h.features.hooks = true;
  h.isFlipt.mockResolvedValue(true);
  h.getSessionUserById.mockImplementation(async (id: number) => ({ id, username: `u${id}` }));
  h.tree = new Map();
  h.blobs = new Map();
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

/** The refusal came before anything was written or committed. */
function expectNothingShipped() {
  expect(dbMock.dbWrite.appBlock.create).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  expect(commitFiles).not.toHaveBeenCalled();
  expect(sourceInserts()).toEqual([]);
}

const hookEntry = { path: HOOK_FILE, sha256: HOOK_SHA, sizeBytes: Buffer.byteLength(HOOK_SRC) };

describe('approveRequest — App Storage permission hooks', () => {
  // INVARIANT GUARD, not regression coverage: a normal flow cannot produce this request. A bundle
  // request's file list is computed at submit from the same content-addressed bundle approve
  // reads, and a push-originated request's list is empty until enrichment fills it from the same
  // sha. The row is hand-built here to pin that `summary_mismatch` would still refuse one.
  it('invariant guard: refuses a reviewed file list that disagrees with the bundle’s hook file', async () => {
    await setBundle({ 'block.manifest.json': '{}', [HOOK_FILE]: HOOK_SRC });
    pendingRequest({
      manifest: manifestPinning(HOOK_SHA),
      files: [{ ...hookEntry, sha256: OTHER_SHA }],
    });
    const err = await rejection(approve());
    expect(err?.name).toBe('StorageHookRefusal');
    expect(err?.problems).toEqual([
      {
        collection: 'cards',
        file: HOOK_FILE,
        reason: 'summary_mismatch',
        expected: OTHER_SHA,
        actual: HOOK_SHA,
      },
    ]);
    expectNothingShipped();
  });

  it('🔴 refuses when the stored bundle’s hook file no longer matches the pinned sha256', async () => {
    const shipped = `${HOOK_SRC}// changed\n`;
    await setBundle({ 'block.manifest.json': '{}', [HOOK_FILE]: shipped });
    pendingRequest({
      manifest: manifestPinning(HOOK_SHA),
      files: [{ ...hookEntry, sha256: sha256(shipped) }],
    });
    const err = await rejection(approve());
    expect(err?.problems).toEqual([
      {
        collection: 'cards',
        file: HOOK_FILE,
        reason: 'sha_mismatch',
        expected: HOOK_SHA,
        actual: sha256(shipped),
      },
    ]);
    expectNothingShipped();
  });

  it('🔴 refuses a new hook when the submitter has left the hooks cohort since submitting', async () => {
    await setBundle({ 'block.manifest.json': '{}', [HOOK_FILE]: HOOK_SRC });
    pendingRequest({ manifest: manifestPinning(HOOK_SHA), files: [hookEntry] });
    h.isFlipt.mockResolvedValue(false);
    const err = await rejection(approve());
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
    ]);
    // The SUBMITTER is evaluated, not the approving moderator.
    expect(h.getSessionUserById).toHaveBeenCalledWith(SUBMITTER);
    expectNothingShipped();
  });

  it('🔴 refuses a push-originated request whose reviewed commit holds a different hook file', async () => {
    const pushed = `${HOOK_SRC}// pushed\n`;
    h.tree.set(HOOK_FILE, 'blob-1');
    h.blobs.set('blob-1', Buffer.from(pushed));
    pendingRequest({ manifest: manifestPinning(HOOK_SHA), files: [], bundleKey: '' });
    const err = await rejection(approve());
    expect(err?.problems).toEqual([
      {
        collection: 'cards',
        file: HOOK_FILE,
        reason: 'sha_mismatch',
        expected: HOOK_SHA,
        actual: sha256(pushed),
      },
    ]);
    expectNothingShipped();
  });

  describe('a later version of an approved app', () => {
    /** An existing app whose approved manifest pins `approvedSha`. */
    const existingApp = (approvedSha: string) => {
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
        id: 'ab_hooks',
        appId: 'appblk-hooks',
        repoUrl: null,
        trustTier: 'unverified',
        app: { allowedScopes: 0, allowedOrigins: [], userId: SUBMITTER },
      });
      const approved = { ...manifestPinning(approvedSha), version: '0.9.0' };
      dbMock.dbWrite.appBlock.findFirst.mockResolvedValue({ id: 'ab_hooks', manifest: approved });
      dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([
        { id: 'pubreq_prev', manifest: approved },
      ]);
    };

    it('🔴 does not re-gate a hook pinned exactly as approved: passes with the submitter outside the cohort', async () => {
      existingApp(HOOK_SHA);
      await setBundle({ 'block.manifest.json': '{}', [HOOK_FILE]: HOOK_SRC });
      pendingRequest({ manifest: manifestPinning(HOOK_SHA), files: [hookEntry] });
      h.isFlipt.mockResolvedValue(false);
      const err = await rejection(approve());
      expect(err?.name).not.toBe('StorageHookRefusal');
      expect(h.isFlipt).not.toHaveBeenCalledWith(
        'app-blocks-storage-hooks',
        expect.anything(),
        expect.anything()
      );
      // Pinned all the same: its bytes verified and its source recorded.
      expect(sourceInserts()).toEqual([[HOOK_SHA]]);
    });

    it('🔴 cohort-gates a hook whose sha256 changed since the approved version', async () => {
      existingApp(OTHER_SHA);
      await setBundle({ 'block.manifest.json': '{}', [HOOK_FILE]: HOOK_SRC });
      pendingRequest({ manifest: manifestPinning(HOOK_SHA), files: [hookEntry] });
      h.isFlipt.mockResolvedValue(false);
      const err = await rejection(approve());
      expect(err?.problems).toEqual([
        { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
      ]);
      expect(h.getSessionUserById).toHaveBeenCalledWith(SUBMITTER);
      expectNothingShipped();
    });
  });

  // Positive control for the refusals above: the same request, consistent, passes the hook pin
  // (its source is recorded, which happens only after every check). What approve does after that
  // is outside this file; whatever it does, it is not a hook refusal.
  it('passes a consistent request and records its hook source', async () => {
    await setBundle({ 'block.manifest.json': '{}', [HOOK_FILE]: HOOK_SRC });
    pendingRequest({ manifest: manifestPinning(HOOK_SHA), files: [hookEntry] });
    const err = await rejection(approve());
    expect(err?.name).not.toBe('StorageHookRefusal');
    expect(sourceInserts()).toEqual([[HOOK_SHA]]);
  });
});

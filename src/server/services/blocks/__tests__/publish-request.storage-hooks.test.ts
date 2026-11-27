import { createHash } from 'crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
// Submit-time deep manifest validation is pinned in publish-request.submitValidation.test.ts;
// this file's fixtures are not full manifests, so that seam is a no-op here (approve's own
// validator is untouched).
vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));
import type * as StorageConstants from '~/shared/constants/block-storage.constants';
import type * as FliptClient from '~/server/flipt/client';

/**
 * App Storage PERMISSION HOOKS — the submit pin and the git-push pin, through the real
 * `submitVersion` and `recordPendingFromPush`.
 *
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR: a version declaring `storage.collections.<c>.hook` used to
 * be queued whatever its file held (the shape is only validated at approve, and nothing compared
 * the pinned sha256 with the bytes). At origin/main every refusal below fails: the submit resolves
 * and the request is inserted.
 *
 * The `hooks` storage feature is switched on HERE (it ships off) by replacing the exported switch,
 * which is the object `storage-hooks.ts` reads; each test that needs it off sets it off. The
 * author cohort gate is the real one, over a mocked Flipt and session lookup. MinIO and Forgejo
 * are stubbed; the db is the canonical mock.
 */

const h = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  s3Send: vi.fn(),
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
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'bundle-bucket-test',
  getBundleS3Client: () => ({ send: h.s3Send }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
  listRepoTreeAtRef: vi.fn(async () => h.tree),
  getBlobContent: vi.fn(async (_slug: string, blobSha: string) => {
    const blob = h.blobs.get(blobSha);
    if (!blob) throw new Error(`no blob ${blobSha}`);
    return blob;
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

// Only the service under test is imported, so at origin/main this file still loads and each
// refusal fails on BEHAVIOUR (the submit resolves), not on a missing module.
const { submitVersion, recordPendingFromPush } = await import(
  '~/server/services/blocks/publish-request.service'
);

const SLUG = 'card-hooks-5e2a';
const EXISTING_APP = 'ab_card_hooks_5201';
const AUTHOR = 9101;
const HOOK_FILE = 'hooks/cards.js';
const HOOK_SRC =
  'export default function check(input) { return { allow: input.op !== "delete" }; }\n';
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const HOOK_SHA = sha256(HOOK_SRC);
const WRONG_SHA = 'f'.repeat(64);
/** A valid pin of SOME earlier file: what an approved version pinned before this one changed it. */
const APPROVED_OLD_SHA = 'a'.repeat(64);
const PUSHER = 9177;

const NOT_IN_COHORT_MESSAGE =
  'storage hooks: storage.collections.cards.hook is new or changed since the approved version, and adding or changing a permission hook is not enabled for this account yet — permission hooks are in a limited rollout; keep the approved hook or remove hook (the collection schema still applies)';

const V1_MANIFEST = {
  blockId: SLUG,
  version: '1.0.0',
  storage: { collections: { cards: { visibility: 'private' } } },
};
const hooked = (hook: Record<string, unknown>) => ({
  collections: { cards: { visibility: 'private', hook } },
});

async function bundle(
  storageDecl: unknown,
  files: Record<string, string | Buffer> = { [HOOK_FILE]: HOOK_SRC },
  extra: Record<string, unknown> = {}
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'block.manifest.json',
    JSON.stringify({
      blockId: SLUG,
      version: '2.0.0',
      name: 'Card Hooks',
      contentRating: 'g',
      scopes: ['apps:storage'],
      storage: storageDecl,
      ...extra,
    })
  );
  zip.file('index.html', '<!doctype html><html><body>cards</body></html>');
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const submit = async (
  storageDecl: unknown,
  files?: Record<string, string | Buffer>,
  extra?: Record<string, unknown>
) =>
  submitVersion({
    bundleBuffer: await bundle(storageDecl, files, extra),
    submittedByUserId: AUTHOR,
    // A moderator: the owner gate on an existing app is pinned in publish-request.orchestration.test.ts.
    submitterIsModerator: true,
  });

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error & { problems?: unknown }
  );

/** The hook-source inserts, as [shas, sources, sizes] (other raw statements are ignored). */
const sourceInserts = () =>
  (dbMock.dbWrite.$executeRaw.mock.calls as unknown[][])
    .filter(([strings]) => (strings as string[]).join('?').includes('app_storage_hook_sources'))
    .map(([, shas, texts, sizes]) => [shas, texts, sizes]);

/** Every MinIO call (submit's only one is the bundle upload). */
const putObjects = () => h.s3Send.mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  h.features.hooks = true;
  h.isFlipt.mockResolvedValue(true);
  h.getSessionUserById.mockImplementation(async (id: number) => ({
    id,
    username: `u${id}`,
    isModerator: false,
  }));
  h.s3Send.mockResolvedValue({});
  h.tree = new Map();
  h.blobs = new Map();
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue({ id: EXISTING_APP, appId: 'appblk-x' });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: AUTHOR } });
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockImplementation((async (args: {
    where: { status?: string };
  }) =>
    args.where.status === 'approved'
      ? { manifest: V1_MANIFEST, fileSummary: { files: [] } }
      : null) as never);
  dbMock.dbWrite.appBlock.findFirst.mockResolvedValue({ id: EXISTING_APP, manifest: V1_MANIFEST });
  dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([
    { id: 'pubreq_v1', manifest: V1_MANIFEST },
  ]);
  dbMock.dbWrite.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

/** Nothing was uploaded, queued or recorded. */
function expectNothingWritten() {
  expect(putObjects()).toHaveLength(0);
  expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  expect(sourceInserts()).toEqual([]);
}

describe('submitVersion — App Storage permission hooks', () => {
  it('🔴 refuses a declared hook while the hooks feature is off, as not available yet', async () => {
    h.features.hooks = false;
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.name).toBe('StorageHookRefusal');
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_available' },
    ]);
    expect(err?.message).toBe(
      'storage hooks: storage.collections.cards.hook is not available yet — permission hooks arrive in a later phase of App Storage; remove hook (the collection schema still applies)'
    );
    // The switch decides before anyone is looked up.
    expect(h.isFlipt).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('🔴 refuses a new hook from an author outside the app-blocks-storage-hooks cohort, as not_in_cohort', async () => {
    h.isFlipt.mockResolvedValue(false);
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
    ]);
    // Its own message: not the "arrives in a later phase" text of the feature switch.
    expect(err?.message).toBe(NOT_IN_COHORT_MESSAGE);
    // Evaluated per author: entityId = the submitter's id, with their Flipt context.
    expect(h.isFlipt).toHaveBeenCalledWith(
      'app-blocks-storage-hooks',
      String(AUTHOR),
      expect.objectContaining({ userId: String(AUTHOR), isLoggedIn: 'true' })
    );
    expectNothingWritten();
  });

  it('🔴 refuses a hook when the author does not resolve (fails closed, not_in_cohort)', async () => {
    h.getSessionUserById.mockResolvedValue(null);
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
    ]);
    expect(h.isFlipt).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('🔴 refuses a hook when Flipt throws (fails closed, not_in_cohort)', async () => {
    h.isFlipt.mockRejectedValue(new Error('flipt down'));
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
    ]);
    expectNothingWritten();
  });

  describe('a hook the approved version already pins', () => {
    /** The app's approved manifest (what the store enforces, and its latest approved request). */
    const approve = (storage: unknown) => {
      const manifest = { ...V1_MANIFEST, storage };
      dbMock.dbWrite.appBlock.findFirst.mockResolvedValue({ id: EXISTING_APP, manifest });
      dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([
        { id: 'pubreq_v1', manifest },
      ]);
    };

    it('🔴 passes an unchanged hook with the author outside the cohort, bytes still verified', async () => {
      approve(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
      h.isFlipt.mockResolvedValue(false);
      const result = await submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
      expect(result.slug).toBe(SLUG);
      expect(h.isFlipt).not.toHaveBeenCalledWith(
        'app-blocks-storage-hooks',
        expect.anything(),
        expect.anything()
      );
      expect(sourceInserts()).toEqual([[[HOOK_SHA], [HOOK_SRC], [Buffer.byteLength(HOOK_SRC)]]]);
    });

    it('🔴 still refuses an unchanged pin whose bundled file no longer matches it', async () => {
      approve(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
      h.isFlipt.mockResolvedValue(false);
      const shipped = `${HOOK_SRC}// edited\n`;
      const err = await rejection(
        submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), { [HOOK_FILE]: shipped })
      );
      expect(err?.problems).toEqual([
        {
          collection: 'cards',
          file: HOOK_FILE,
          reason: 'sha_mismatch',
          expected: HOOK_SHA,
          actual: sha256(shipped),
        },
      ]);
      expectNothingWritten();
    });

    it('🔴 cohort-gates a changed sha256', async () => {
      approve(hooked({ file: HOOK_FILE, sha256: APPROVED_OLD_SHA }));
      h.isFlipt.mockResolvedValue(false);
      const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
      expect(err?.problems).toEqual([
        { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
      ]);
      expect(h.isFlipt).toHaveBeenCalledWith(
        'app-blocks-storage-hooks',
        String(AUTHOR),
        expect.anything()
      );
      expectNothingWritten();
    });

    it('🔴 cohort-gates a changed file at the same sha256', async () => {
      approve(hooked({ file: 'hooks/old.js', sha256: HOOK_SHA }));
      h.isFlipt.mockResolvedValue(false);
      const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
      expect(err?.problems).toEqual([
        { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
      ]);
      expectNothingWritten();
    });

    it('🔴 refuses only the new hook when one is unchanged and one is new', async () => {
      approve(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
      h.isFlipt.mockResolvedValue(false);
      const err = await rejection(
        submit({
          collections: {
            cards: { visibility: 'private', hook: { file: HOOK_FILE, sha256: HOOK_SHA } },
            notes: { visibility: 'private', hook: { file: HOOK_FILE, sha256: HOOK_SHA } },
          },
        })
      );
      expect(err?.problems).toEqual([
        { collection: 'notes', file: HOOK_FILE, reason: 'not_in_cohort' },
      ]);
      expectNothingWritten();
    });

    it('🔴 the feature switch still refuses an unchanged hook, as not_available', async () => {
      approve(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
      h.features.hooks = false;
      const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
      expect(err?.problems).toEqual([
        { collection: 'cards', file: HOOK_FILE, reason: 'not_available' },
      ]);
      expectNothingWritten();
    });
  });

  it('🔴 refuses a sha256 that is not the bundled file’s', async () => {
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: WRONG_SHA })));
    expect(err?.name).toBe('StorageHookRefusal');
    expect(err?.problems).toEqual([
      {
        collection: 'cards',
        file: HOOK_FILE,
        reason: 'sha_mismatch',
        expected: WRONG_SHA,
        actual: HOOK_SHA,
      },
    ]);
    expectNothingWritten();
  });

  it('🔴 refuses a hook file the bundle does not contain', async () => {
    const err = await rejection(
      submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), { 'hooks/other.js': HOOK_SRC })
    );
    expect(err?.problems).toEqual([{ collection: 'cards', file: HOOK_FILE, reason: 'missing' }]);
    expectNothingWritten();
  });

  it('🔴 refuses a hook file over 65536 bytes, even with the right sha256', async () => {
    const big = `//${'x'.repeat(65_535)}`; // 65537 bytes
    const err = await rejection(
      submit(hooked({ file: HOOK_FILE, sha256: sha256(big) }), { [HOOK_FILE]: big })
    );
    expect(err?.problems).toEqual([
      {
        collection: 'cards',
        file: HOOK_FILE,
        reason: 'too_large',
        expected: '65536',
        actual: '65537',
      },
    ]);
    expectNothingWritten();
  });

  it('🔴 refuses a hook file that is not text, even with the right sha256', async () => {
    const binary = Buffer.from([0x65, 0x78, 0x00, 0x70]);
    const err = await rejection(
      submit(hooked({ file: HOOK_FILE, sha256: sha256(binary) }), { [HOOK_FILE]: binary })
    );
    expect(err?.problems).toEqual([{ collection: 'cards', file: HOOK_FILE, reason: 'not_text' }]);
    expectNothingWritten();
  });

  it('🔴 refuses a hook file inside outputDir', async () => {
    const file = 'dist/cards.js';
    const err = await rejection(
      submit(
        hooked({ file, sha256: HOOK_SHA }),
        { [file]: HOOK_SRC },
        {
          buildCommand: 'npm run build',
          outputDir: 'dist',
        }
      )
    );
    expect(err?.problems).toEqual([{ collection: 'cards', file, reason: 'under_output_dir' }]);
    expectNothingWritten();
  });

  it('🔴 refuses a malformed hook declaration with the parser’s reason', async () => {
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: 'ABC' })));
    expect(err?.problems).toEqual([{ collection: 'cards', file: HOOK_FILE, reason: 'invalid' }]);
    expect(err?.message).toContain(
      'storage.collections.cards.hook.sha256 is required and must be the SHA-256 of the file as 64 lowercase hex characters'
    );
    expectNothingWritten();
  });

  it('accepts the right sha256 and records the hook source by its sha', async () => {
    const result = await submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA, timeoutMs: 80 }));
    expect(result.slug).toBe(SLUG);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(1);
    expect(sourceInserts()).toEqual([[[HOOK_SHA], [HOOK_SRC], [Buffer.byteLength(HOOK_SRC)]]]);
  });

  it('records the source append-only: a sha already stored is never updated', async () => {
    await submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
    const statements = (dbMock.dbWrite.$executeRaw.mock.calls as unknown[][])
      .map(([strings]) => (strings as string[]).join('?').replace(/\s+/g, ' '))
      .filter((sql) => sql.includes('app_storage_hook_sources'));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('ON CONFLICT ("sha256") DO NOTHING');
    expect(statements[0]).not.toMatch(/DO UPDATE/i);
  });

  it('records a hook file that starts with a UTF-8 BOM as text that still hashes to its sha256', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(HOOK_SRC, 'utf8')]);
    const sha = sha256(bytes);
    await submit(hooked({ file: HOOK_FILE, sha256: sha }), { [HOOK_FILE]: bytes });
    const [[shas, texts]] = sourceInserts() as [[string[], string[]]];
    expect(shas).toEqual([sha]);
    expect(sha256(Buffer.from(texts[0], 'utf8'))).toBe(sha);
  });

  it('records one source for one file shared by two collections', async () => {
    await submit({
      collections: {
        cards: { visibility: 'private', hook: { file: HOOK_FILE, sha256: HOOK_SHA } },
        notes: { visibility: 'private', hook: { file: HOOK_FILE, sha256: HOOK_SHA } },
      },
    });
    expect(sourceInserts()).toEqual([[[HOOK_SHA], [HOOK_SRC], [Buffer.byteLength(HOOK_SRC)]]]);
  });

  it('🔴 refuses when the hand-applied source table is absent, before queueing', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(
      Object.assign(new Error('relation "app_storage_hook_sources" does not exist'), {
        code: '42P01',
      })
    );
    const err = await rejection(submit(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.message).toBe(
      'storage hooks: the app_storage_hook_sources table does not exist yet, so the hook source cannot be recorded — apply migration 20261224120000_app_storage_hook_sources, then submit again'
    );
    expect(putObjects()).toHaveLength(0);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  // INVARIANT GUARD (main already behaves this way): a manifest with no hook never consults the
  // gate and records nothing.
  it('a manifest with no hook is untouched by the hook pin', async () => {
    const result = await submit({ collections: { cards: { visibility: 'private' } } });
    expect(result.slug).toBe(SLUG);
    expect(h.getSessionUserById).not.toHaveBeenCalled();
    expect(h.isFlipt).not.toHaveBeenCalledWith(
      'app-blocks-storage-hooks',
      expect.anything(),
      expect.anything()
    );
    expect(sourceInserts()).toEqual([]);
  });
});

describe('recordPendingFromPush — App Storage permission hooks', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const push = (storage: unknown, pusherUserId: number | null = AUTHOR) =>
    recordPendingFromPush({
      slug: SLUG,
      sha: SHA,
      appBlockId: EXISTING_APP,
      manifest: { blockId: SLUG, version: '2.0.0', storage },
      version: '2.0.0',
      pusherUserId,
    });
  /** The cohort holds exactly these users. */
  const cohort = (...ids: number[]) =>
    h.isFlipt.mockImplementation(async (_flag: string, entityId: string) =>
      ids.map(String).includes(entityId)
    );
  const pushFile = (path: string, content: string) => {
    h.tree.set(path, `blob-${path}`);
    h.blobs.set(`blob-${path}`, Buffer.from(content));
  };

  it('🔴 refuses a pushed hook whose file does not match its sha256, recording nothing', async () => {
    pushFile(HOOK_FILE, `${HOOK_SRC}// edited after pinning\n`);
    const err = await rejection(push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.name).toBe('StorageHookRefusal');
    expect(err?.problems).toEqual([
      {
        collection: 'cards',
        file: HOOK_FILE,
        reason: 'sha_mismatch',
        expected: HOOK_SHA,
        actual: sha256(`${HOOK_SRC}// edited after pinning\n`),
      },
    ]);
    // Refused before the supersede: the pending queue is untouched.
    expect(dbMock.dbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    expect(sourceInserts()).toEqual([]);
  });

  it('🔴 gates the PUSHER, not the owner: a pusher outside the cohort is refused', async () => {
    pushFile(HOOK_FILE, HOOK_SRC);
    cohort(AUTHOR); // the owner is in, the pusher is not
    const err = await rejection(push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), PUSHER));
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
    ]);
    expect(err?.message).toBe(NOT_IN_COHORT_MESSAGE);
    expect(h.getSessionUserById).toHaveBeenCalledWith(PUSHER);
    expect(h.getSessionUserById).not.toHaveBeenCalledWith(AUTHOR);
    expect(dbMock.dbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('🔴 gates the PUSHER, not the owner: a pusher in the cohort passes with the owner outside it', async () => {
    pushFile(HOOK_FILE, HOOK_SRC);
    cohort(PUSHER);
    const res = await push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), PUSHER);
    expect(res.publishRequestId).toMatch(/^pubreq_/);
    expect(h.isFlipt).toHaveBeenCalledWith(
      'app-blocks-storage-hooks',
      String(PUSHER),
      expect.anything()
    );
    expect(sourceInserts()).toEqual([[[HOOK_SHA], [HOOK_SRC], [Buffer.byteLength(HOOK_SRC)]]]);
  });

  it('🔴 refuses a new pushed hook when the pusher does not resolve to a user (fails closed)', async () => {
    pushFile(HOOK_FILE, HOOK_SRC);
    const err = await rejection(push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), null));
    expect(err?.problems).toEqual([
      { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
    ]);
    expect(h.getSessionUserById).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  describe('a pushed hook the approved version already pins', () => {
    beforeEach(() => {
      const manifest = { ...V1_MANIFEST, storage: hooked({ file: HOOK_FILE, sha256: HOOK_SHA }) };
      dbMock.dbWrite.appBlock.findFirst.mockResolvedValue({ id: EXISTING_APP, manifest });
      dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([
        { id: 'pubreq_v1', manifest },
      ]);
      pushFile(HOOK_FILE, HOOK_SRC);
      cohort();
    });

    it('🔴 passes unchanged with the pusher outside the cohort (or unresolved)', async () => {
      const res = await push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), null);
      expect(res.publishRequestId).toMatch(/^pubreq_/);
      expect(h.isFlipt).not.toHaveBeenCalledWith(
        'app-blocks-storage-hooks',
        expect.anything(),
        expect.anything()
      );
      expect(sourceInserts()).toEqual([[[HOOK_SHA], [HOOK_SRC], [Buffer.byteLength(HOOK_SRC)]]]);
    });

    it('🔴 treats the hook as new when the approved manifest cannot be read (fails closed)', async () => {
      dbMock.dbWrite.appBlock.findFirst.mockRejectedValue(new Error('db down'));
      const err = await rejection(push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }), PUSHER));
      expect(err?.problems).toEqual([
        { collection: 'cards', file: HOOK_FILE, reason: 'not_in_cohort' },
      ]);
      expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
      expect(sourceInserts()).toEqual([]);
    });
  });

  it('🔴 refuses a pushed hook file the commit does not contain', async () => {
    const err = await rejection(push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA })));
    expect(err?.problems).toEqual([{ collection: 'cards', file: HOOK_FILE, reason: 'missing' }]);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('records the pending review and the hook source when the pushed file matches', async () => {
    pushFile(HOOK_FILE, HOOK_SRC);
    const res = await push(hooked({ file: HOOK_FILE, sha256: HOOK_SHA }));
    expect(res.publishRequestId).toMatch(/^pubreq_/);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(1);
    expect(sourceInserts()).toEqual([[[HOOK_SHA], [HOOK_SRC], [Buffer.byteLength(HOOK_SRC)]]]);
  });
});

// ---------------------------------------------------------------------------
// STAFF PLATFORM UPDATES on the same two paths (`platform-update-bundle-check.ts`): the real check
// and the real record query text over the canonical db mock (the query's own behaviour against
// the migrations is pinned in platform-update-bundle-check.pglite.test.ts), with this file's
// stubbed git host and MinIO. Here because it needs exactly this harness.
//
// 🔴 THE REGRESSION: at origin/main a bundle (or a push) that lacks a staff update no approved
// version has shipped is queued as if it had it, and nothing tells the moderator. Every refusal
// and every record below fails there.
// ---------------------------------------------------------------------------

const forgejo = await import('~/server/services/blocks/forgejo.service');
const { FORGEJO_SOURCE_ORG } = await import('~/server/services/blocks/forgejo-orgs');

describe('staff platform updates', () => {
  const pu = {
    platformFlag: true,
    /** `${org ?? 'build'}@${ref}` → path → blob sha (blobs in `h.blobs`) */
    trees: new Map<string, Map<string, string>>(),
    /** The rows the platform-update query answers with; an Error is thrown instead. */
    updateRows: [] as unknown[] | Error,
  };
  // Loaded where used, so at origin/main (where it does not exist) every other case still runs and
  // fails on BEHAVIOUR.
  const reviewLines = async (fileSummary: unknown) =>
    (await import('~/components/Apps/reviewPlatformUpdates')).reviewPlatformUpdatesLines(
      fileSummary
    );

  const PU_SLUG = 'bundle-gate-int';
  const PU_APP = 'ab_bundle_gate_int';
  const PU_AUTHOR = 9301;
  const PU_BASE_SHA = 'b'.repeat(40);
  const PU_UPDATE_SHA = 'c'.repeat(40);
  const PU_PUSHED_SHA = 'd'.repeat(40);

  const PU_BASE_TEXT = 'export const a = 1;\n';
  const PU_UPDATE_TEXT = 'export const a = 1;\nexport const staffFix = true;\n';

  const PU_MESSAGE =
    'this bundle does not contain a platform update from Civitai staff that has not shipped yet: ' +
    'apu_int by mod-jane ("Fix the deprecated SDK call"): src/a.ts. Merge it into the app and ' +
    'submit again, or submit with --allow-unmerged-platform-update (allowUnmergedPlatformUpdate: ' +
    'true) to send it for review without it; the moderator is shown what was left out';
  const PU_MISSING = [
    { id: 'apu_int', reason: 'Fix the deprecated SDK call', by: 'mod-jane', paths: ['src/a.ts'] },
  ];
  const PU_RECORD = (via: 'override' | 'push') => ({
    via,
    updates: [{ id: 'apu_int', by: 'mod-jane', paths: ['src/a.ts'] }],
  });

  /** The record's row as the service's query returns it. */
  const updateRow = (over: Record<string, unknown> = {}) => ({
    id: 'apu_int',
    appBlockId: PU_APP,
    slug: PU_SLUG,
    staffUserId: 51,
    reason: 'Fix the deprecated SDK call',
    branch: 'platform-update/apu_int',
    baseCommitSha: PU_BASE_SHA,
    commitSha: PU_UPDATE_SHA,
    paths: [{ path: 'src/a.ts', operation: 'update' }],
    touchesManifest: false,
    status: 'pending',
    mergeCommitSha: null,
    seededSourceRepo: false,
    createdAt: new Date('2027-01-01T00:00:00Z'),
    resolvedAt: null,
    staffUsername: 'mod-jane',
    staffIsModerator: true,
    staffBannedAt: null,
    staffDeletedAt: null,
    ...over,
  });

  async function puBundle(files: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      'block.manifest.json',
      JSON.stringify({
        blockId: PU_SLUG,
        version: '2.0.0',
        name: 'Bundle Gate',
        contentRating: 'g',
      })
    );
    zip.file('index.html', '<!doctype html><html><body>gate</body></html>');
    for (const [path, content] of Object.entries(files)) zip.file(path, content);
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
  }

  const puSubmit = async (files: Record<string, string>, extra: Record<string, unknown> = {}) =>
    submitVersion({
      bundleBuffer: await puBundle(files),
      submittedByUserId: PU_AUTHOR,
      // A moderator queueing a version of another account's app: the on-behalf path. An owner's
      // puSubmit runs the same lines (the check comes after the owner gate either way).
      submitterIsModerator: true,
      ...extra,
    });

  const puRejection = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as Error & { code?: string; status?: number; details?: unknown }
    );

  /** The platform-update record queries the service ran. */
  const updateQueries = () =>
    (dbMock.dbWrite.$queryRaw.mock.calls as unknown[][]).filter(([sql]) =>
      JSON.stringify(sql).includes('app_platform_updates')
    );

  const createdFileSummary = () =>
    (
      dbMock.dbWrite.appBlockPublishRequest.create.mock.calls[0]?.[0] as {
        data: { fileSummary: Record<string, unknown> };
      }
    )?.data.fileSummary;

  beforeEach(async () => {
    // The outer beforeEach switched every flag on; here only the platform-updates flag answers.
    const { FLIPT_FEATURE_FLAGS } = await import('~/server/flipt/client');
    h.isFlipt.mockImplementation(async (flag: string) =>
      flag === FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES ? pu.platformFlag : false
    );
    // Trees by repo and commit: the app's source repo (the update's two commits) and the build
    // repo (the pushed commit, read with the default org).
    vi.mocked(forgejo.listRepoTreeAtRef).mockImplementation(async (_slug, ref, org) => {
      const tree = pu.trees.get(`${org ?? 'build'}@${ref}`);
      if (!tree) throw new Error(`no tree ${org ?? 'build'}@${ref}`);
      return tree;
    });
    pu.platformFlag = true;
    pu.updateRows = [updateRow()];
    h.blobs = new Map([
      ['blob-base', Buffer.from(PU_BASE_TEXT)],
      ['blob-update', Buffer.from(PU_UPDATE_TEXT)],
    ]);
    pu.trees = new Map([
      [`${FORGEJO_SOURCE_ORG}@${PU_BASE_SHA}`, new Map([['src/a.ts', 'blob-base']])],
      [`${FORGEJO_SOURCE_ORG}@${PU_UPDATE_SHA}`, new Map([['src/a.ts', 'blob-update']])],
    ]);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: unknown) => {
      if (!JSON.stringify(sql).includes('app_platform_updates')) return [];
      if (pu.updateRows instanceof Error) throw pu.updateRows;
      return pu.updateRows;
    }) as never);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue({ id: PU_APP, appId: 'appblk-int' });
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: PU_AUTHOR } });
    dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
    dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
    dbMock.dbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([]);
    dbMock.dbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
  });
  afterEach(() => {
    vi.mocked(forgejo.listRepoTreeAtRef).mockImplementation(async () => h.tree);
  });

  describe('submitVersion — staff platform updates', () => {
    it('🔴 refuses a bundle missing an unshipped update: code, 409, message, details; nothing queued', async () => {
      const err = await puRejection(puSubmit({ 'src/a.ts': PU_BASE_TEXT }));
      expect(err?.name).toBe('PlatformUpdateMissingRefusal');
      expect(err?.code).toBe('platform_update_missing');
      expect(err?.status).toBe(409);
      expect(err?.message).toBe(PU_MESSAGE);
      expect(err?.details).toEqual({ updates: PU_MISSING });
      expect(h.s3Send).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    });

    it('🔴 with allowUnmergedPlatformUpdate: queued, recorded for the moderator, and an advisory', async () => {
      const result = await puSubmit(
        { 'src/a.ts': PU_BASE_TEXT },
        { allowUnmergedPlatformUpdate: true }
      );
      expect(createdFileSummary().platformUpdatesMissing).toEqual(PU_RECORD('override'));
      expect(result.advisories).toContainEqual({
        code: 'platform-update-missing',
        message:
          'Submitted without a platform update from Civitai staff: apu_int by mod-jane ("Fix the ' +
          'deprecated SDK call"): src/a.ts. The moderator reviewing this version is shown what it left out.',
      });
      // The review line reads exactly what the puSubmit wrote (writer → reader, one fixture).
      expect(await reviewLines(createdFileSummary())).toEqual([
        {
          key: 'platform-updates',
          heading: 'Missing platform updates (submitted with --allow-unmerged-platform-update)',
          value: 'apu_int by mod-jane: src/a.ts',
        },
      ]);
    });

    it('🔴 a staff on-behalf submit is never refused: recorded via on-behalf, with an advisory', async () => {
      const result = await puSubmit({ 'src/a.ts': PU_BASE_TEXT }, { submittedOnBehalf: true });
      expect(result.publishRequestId).toMatch(/^pubreq_/);
      expect(createdFileSummary().platformUpdatesMissing).toEqual({
        ...PU_RECORD('override'),
        via: 'on-behalf',
      });
      expect(result.advisories.map((a) => a.code)).toContain('platform-update-missing');
      expect((await reviewLines(createdFileSummary()))[0]?.heading).toBe(
        "Missing platform updates (Civitai staff submission on the owner's behalf)"
      );
    });

    it('🔴 the on-behalf submit’s own params (onBehalf + submittedOnBehalf): queued, and its approve ships nothing', async () => {
      // What `submitPlatformUpdateOnBehalf` hands `submitVersion`: a bundle carrying ANOTHER
      // update's base file (apu_int is unshipped and absent from it), filed by a moderator for
      // the app's owner.
      const onBehalf = {
        platformUpdateId: 'apu_staff_submit',
        staffUsername: 'mod-ana',
        ownerUserId: PU_AUTHOR,
        ownerUsername: 'owner-olga',
      };
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
        id: PU_APP,
        appId: 'appblk-int',
        app: { userId: PU_AUTHOR },
      });
      const result = await puSubmit(
        { 'src/a.ts': PU_BASE_TEXT },
        { submittedByUserId: 8001, submittedOnBehalf: true, onBehalf }
      );
      expect(result.publishRequestId).toMatch(/^pubreq_/);
      const fileSummary = createdFileSummary();
      expect(fileSummary.platformUpdatesMissing).toEqual({
        ...PU_RECORD('override'),
        via: 'on-behalf',
      });
      expect(fileSummary.onBehalf).toEqual({ ...onBehalf, staffUserId: 8001 });

      // The approve step reads that same fileSummary: nothing is marked shipped, even for bytes
      // that DO contain apu_int.
      const { markShippedPlatformUpdates } = await import(
        '~/server/services/blocks/platform-update-bundle-check'
      );
      const readFiles = async () => new Map([['src/a.ts', Buffer.from(PU_UPDATE_TEXT)]]);
      const shippedWrites = () =>
        (dbMock.dbWrite.$executeRaw.mock.calls as unknown[][]).filter(([strings]) =>
          (strings as string[]).join('?').includes('shipped_in_publish_request_id')
        );
      dbMock.dbWrite.$executeRaw.mockClear();
      const args = { appBlockId: PU_APP, publishRequestId: result.publishRequestId, readFiles };
      expect(await markShippedPlatformUpdates({ ...args, fileSummary })).toEqual([]);
      expect(shippedWrites()).toHaveLength(0);
      // Control: the same bytes approved as the owner's own build ship it.
      const { onBehalf: _staff, ...ownerSummary } = fileSummary;
      expect(await markShippedPlatformUpdates({ ...args, fileSummary: ownerSummary })).toEqual([
        'apu_int',
      ]);
      expect(shippedWrites()).toHaveLength(1);
    });

    it('🔴 re-approving a reset-to-pending clone of an on-behalf request ships nothing; an ordinary clone still ships', async () => {
      // A moderator's reset-to-pending clones the approved request as the OWNER's
      // (`resetOnsiteListingToPending` writes `ownerCopyOf(fileSummary)`), but the bytes are still
      // the staff build: only an owner's own build ships an update.
      const onBehalf = {
        platformUpdateId: 'apu_staff_submit',
        staffUsername: 'mod-ana',
        ownerUserId: PU_AUTHOR,
        ownerUsername: 'owner-olga',
      };
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
        id: PU_APP,
        appId: 'appblk-int',
        app: { userId: PU_AUTHOR },
      });
      const result = await puSubmit(
        { 'src/a.ts': PU_BASE_TEXT },
        { submittedByUserId: 8001, submittedOnBehalf: true, onBehalf }
      );
      const fileSummary = createdFileSummary();
      const { ownerCopyOf, readOnBehalf } = await import(
        '~/shared/utils/publish-request-on-behalf'
      );
      const clone = ownerCopyOf(fileSummary);
      // The clone is the owner's: no staff label, owner-style notify and reject.
      expect(readOnBehalf(clone)).toBeNull();

      const { markShippedPlatformUpdates } = await import(
        '~/server/services/blocks/platform-update-bundle-check'
      );
      const readFiles = async () => new Map([['src/a.ts', Buffer.from(PU_UPDATE_TEXT)]]);
      const shippedWrites = () =>
        (dbMock.dbWrite.$executeRaw.mock.calls as unknown[][]).filter(([strings]) =>
          (strings as string[]).join('?').includes('shipped_in_publish_request_id')
        );
      dbMock.dbWrite.$executeRaw.mockClear();
      const args = { appBlockId: PU_APP, publishRequestId: result.publishRequestId, readFiles };
      // Bytes that DO contain apu_int: the clone's re-approve still marks nothing.
      expect(await markShippedPlatformUpdates({ ...args, fileSummary: clone })).toEqual([]);
      expect(shippedWrites()).toHaveLength(0);
      // Control: a reset clone of an ordinary (owner) request ships it.
      const { onBehalf: _staff, ...ownerSummary } = fileSummary;
      expect(
        await markShippedPlatformUpdates({ ...args, fileSummary: ownerCopyOf(ownerSummary) })
      ).toEqual(['apu_int']);
      expect(shippedWrites()).toHaveLength(1);
    });

    it('submittedOnBehalf from a submitter who is not a moderator is refused before anything', async () => {
      const err = await puRejection(
        puSubmit(
          { 'src/a.ts': PU_UPDATE_TEXT },
          { submittedOnBehalf: true, submitterIsModerator: false }
        )
      );
      expect(err?.message).toBe('only a moderator can submit on behalf of an app owner');
      expect(updateQueries()).toHaveLength(0);
      expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    });

    it('🔴 an update whose commit cannot be read refuses as missing, not a read error; the override queues it', async () => {
      pu.trees.delete(`${FORGEJO_SOURCE_ORG}@${PU_UPDATE_SHA}`);
      const err = await puRejection(puSubmit({ 'src/a.ts': PU_UPDATE_TEXT }));
      expect(err?.code).toBe('platform_update_missing');
      expect(err?.details).toEqual({ updates: [{ ...PU_MISSING[0], unreadable: true }] });
      expect(err?.message).toContain('Civitai staff can withdraw it');
      const result = await puSubmit(
        { 'src/a.ts': PU_UPDATE_TEXT },
        { allowUnmergedPlatformUpdate: true }
      );
      expect(result.publishRequestId).toMatch(/^pubreq_/);
      expect(createdFileSummary().platformUpdatesMissing).toEqual({
        via: 'override',
        updates: [{ id: 'apu_int', by: 'mod-jane', paths: ['src/a.ts'], unreadable: true }],
      });
    });

    it('accepts a bundle that has the update’s exact file, and records nothing', async () => {
      const result = await puSubmit({ 'src/a.ts': PU_UPDATE_TEXT });
      expect(result.publishRequestId).toMatch(/^pubreq_/);
      expect(createdFileSummary()).not.toHaveProperty('platformUpdatesMissing');
      expect(result.advisories.map((a) => a.code)).not.toContain('platform-update-missing');
      // Positive control: the check did run (one query).
      expect(updateQueries()).toHaveLength(1);
    });

    it('accepts a hand-merged file that has every line the update adds', async () => {
      const merged =
        '// owner\nexport const a = 1;\nexport const owner = 3;\nexport const staffFix = true;\n';
      const result = await puSubmit({ 'src/a.ts': merged });
      expect(result.publishRequestId).toMatch(/^pubreq_/);
      expect(createdFileSummary()).not.toHaveProperty('platformUpdatesMissing');
    });

    it('accepts a bundle that holds a delete update (the path gone)', async () => {
      pu.updateRows = [updateRow({ paths: [{ path: 'src/a.ts', operation: 'delete' }] })];
      pu.trees.set(`${FORGEJO_SOURCE_ORG}@${PU_UPDATE_SHA}`, new Map());
      await expect(puSubmit({ 'src/b.ts': 'b\n' })).resolves.toMatchObject({ slug: PU_SLUG });
      // …and refuses one that still carries the deleted file.
      const err = await puRejection(puSubmit({ 'src/a.ts': PU_BASE_TEXT }));
      expect(err?.code).toBe('platform_update_missing');
    });

    it('is off with the flag off: no query, the bundle is queued', async () => {
      pu.platformFlag = false;
      await expect(puSubmit({ 'src/a.ts': PU_BASE_TEXT })).resolves.toMatchObject({
        slug: PU_SLUG,
      });
      expect(updateQueries()).toHaveLength(0);
    });

    it('is off while the table is missing: the bundle is queued', async () => {
      pu.updateRows = Object.assign(new Error('relation "app_platform_updates" does not exist'), {
        code: '42P01',
      });
      await expect(puSubmit({ 'src/a.ts': PU_BASE_TEXT })).resolves.toMatchObject({
        slug: PU_SLUG,
      });
      expect(updateQueries()).toHaveLength(1);
    });

    it('a first version (no app yet) is not checked', async () => {
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
      await expect(puSubmit({ 'src/a.ts': PU_BASE_TEXT })).resolves.toMatchObject({
        slug: PU_SLUG,
      });
      expect(updateQueries()).toHaveLength(0);
    });
  });

  describe('recordPendingFromPush — staff platform updates', () => {
    const push = () =>
      recordPendingFromPush({
        slug: PU_SLUG,
        sha: PU_PUSHED_SHA,
        appBlockId: PU_APP,
        manifest: { blockId: PU_SLUG, version: '2.0.0', name: 'Bundle Gate' },
        version: '2.0.0',
        pusherUserId: PU_AUTHOR,
      });

    it('🔴 a push missing an update is recorded, not refused: the moderator record and an advisory', async () => {
      pu.trees.set(`build@${PU_PUSHED_SHA}`, new Map([['src/a.ts', 'blob-base']]));
      const result = await push();
      expect(result.publishRequestId).toMatch(/^pubreq_/);
      expect(createdFileSummary().platformUpdatesMissing).toEqual(PU_RECORD('push'));
      expect(result.advisories).toEqual([
        {
          code: 'platform-update-missing',
          message:
            'This commit does not contain a platform update from Civitai staff: apu_int by mod-jane ' +
            '("Fix the deprecated SDK call"): src/a.ts. It was recorded for review anyway, and the ' +
            'moderator is shown what it left out. Merge it and push again.',
        },
      ]);
      expect((await reviewLines(createdFileSummary()))[0]?.heading).toBe(
        'Missing platform updates (git push, recorded without them)'
      );
    });

    it('🔴 the background diff enrichment keeps the record', async () => {
      h.blobs.set(
        'blob-manifest',
        Buffer.from(JSON.stringify({ blockId: PU_SLUG, version: '2.0.0', name: 'Bundle Gate' }))
      );
      pu.trees.set(
        `build@${PU_PUSHED_SHA}`,
        new Map([
          ['block.manifest.json', 'blob-manifest'],
          ['src/a.ts', 'blob-base'],
        ])
      );
      await push();
      await vi.waitFor(
        () =>
          expect(dbMock.dbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({
                fileSummary: expect.objectContaining({ platformUpdatesMissing: PU_RECORD('push') }),
              }),
            })
          ),
        // The enrichment is fire-and-forget (a zip rebuild); a cold worker can take seconds.
        { timeout: 10_000 }
      );
    });

    it('a push that contains the update records nothing and says nothing', async () => {
      pu.trees.set(`build@${PU_PUSHED_SHA}`, new Map([['src/a.ts', 'blob-update']]));
      const result = await push();
      expect(createdFileSummary()).not.toHaveProperty('platformUpdatesMissing');
      expect(result.advisories).toEqual([]);
      expect(updateQueries()).toHaveLength(1);
    });
  });
});

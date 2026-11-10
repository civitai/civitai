import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
// Submit-time deep manifest validation is pinned in publish-request.submitValidation.test.ts;
// this file's fixtures are not full manifests, so that seam is a no-op here (approve's own
// validator is untouched).
vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));

/**
 * App Storage schema migrations — the SUBMIT gate, through the real `submitVersion`.
 *
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR: a version that narrows a collection schema against
 * the previous APPROVED version used to be accepted silently, leaving every stored document
 * that the old schema allowed unwritable (for the app and every fork writing its collections).
 * At origin/main the first case fails: `submitVersion` resolves and inserts the request.
 *
 * Runs the real submit pipeline (zip parse, manifest checks, previous-version diff, request
 * create) over the canonical db mock; MinIO and Forgejo are stubbed.
 */

const s3Send = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'bundle-bucket-test',
  getBundleS3Client: () => ({ send: s3Send }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
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

// Only the service under test is imported, so at origin/main this file still loads and the
// first case fails on BEHAVIOUR (the submit resolves), not on a missing module.
const { submitVersion } = await import('~/server/services/blocks/publish-request.service');

const SLUG = 'card-shelf-7d1e';
const EXISTING_APP = 'ab_card_shelf_7101';

const V1_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 60 },
    stars: { type: 'integer', maximum: 10 },
  },
};
/** V1 with `stars` capped lower and a newly required `status`. */
const V2_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    title: { type: 'string', maxLength: 60 },
    stars: { type: 'integer', maximum: 5 },
    status: { enum: ['draft', 'live'] },
  },
};

const storage = (collection: Record<string, unknown>) => ({
  collections: { cards: { visibility: 'private', ...collection } },
});
const V1_MANIFEST = { blockId: SLUG, version: '1.0.0', storage: storage({ schema: V1_SCHEMA }) };

async function bundle(version: string, storageDecl: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'block.manifest.json',
    JSON.stringify({
      blockId: SLUG,
      version,
      name: 'Card Shelf',
      contentRating: 'g',
      scopes: ['apps:storage'],
      storage: storageDecl,
    })
  );
  zip.file('index.html', '<!doctype html><html><body>cards</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue({ id: EXISTING_APP, appId: 'appblk-x' });
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  // No pending request; the previous APPROVED version declares V1 (the file diff's read).
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockImplementation((async (args: {
    where: { status?: string };
  }) =>
    args.where.status === 'approved'
      ? { manifest: V1_MANIFEST, fileSummary: { files: [] } }
      : null) as never);
  // What the store enforces (the schema-migration baseline, on the primary): V1 too.
  dbMock.dbWrite.appBlock.findFirst.mockResolvedValue({ id: EXISTING_APP, manifest: V1_MANIFEST });
  dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([
    { id: 'pubreq_v1', manifest: V1_MANIFEST },
  ]);
});

const submit = async (storageDecl: unknown) =>
  submitVersion({
    bundleBuffer: await bundle('2.0.0', storageDecl),
    submittedByUserId: 9101,
    // A moderator: the owner gate on an existing app is pinned in publish-request.orchestration.test.ts.
    submitterIsModerator: true,
  });

describe('submitVersion — App Storage schema migrations', () => {
  it('🔴 refuses a narrowed schema with no migration, before anything is uploaded or inserted', async () => {
    const err = await submit(storage({ schema: V2_SCHEMA })).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('StorageMigrationRefusal');
    expect((err as { breaking?: unknown }).breaking).toEqual([
      { collection: 'cards', pointer: '/status', keyword: 'required', old: false, new: true },
      { collection: 'cards', pointer: '/stars', keyword: 'maximum', old: 10, new: 5 },
    ]);
    expect((err as Error).message).toContain(
      'no migration covers them: cards "/status" required: false → true; cards "/stars" maximum: 10 → 5.'
    );
    expect(s3Send).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('accepts the same schema once every breaking change is covered', async () => {
    const result = await submit(
      storage({
        schema: V2_SCHEMA,
        migrations: [
          { op: 'default', path: '/status', value: 'draft' },
          { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
        ],
      })
    );
    expect(result.slug).toBe(SLUG);
    expect(result.storageMigrationWarnings).toEqual([]);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a default value the new schema would itself reject', async () => {
    await expect(
      submit(
        storage({
          schema: V2_SCHEMA,
          migrations: [
            { op: 'default', path: '/status', value: 'archived' },
            { op: 'acknowledge', path: '/stars', keyword: 'maximum' },
          ],
        })
      )
    ).rejects.toThrow(
      'storage.collections.cards.migrations[0].value does not match the new schema at "/status": must be one of the schema\'s enum values'
    );
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('an unchanged schema with a stale migration block is accepted, with a warning', async () => {
    const result = await submit(
      storage({ schema: V1_SCHEMA, migrations: [{ op: 'remove', path: '/legacy' }] })
    );
    expect(result.storageMigrationWarnings).toEqual([
      'storage.collections.cards.migrations[0] (remove) covers no breaking change between the previous approved version and this one, so it will not run — remove it from the manifest',
    ]);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(1);
  });

  it('a widened schema needs no migration', async () => {
    const widened = {
      ...V1_SCHEMA,
      properties: { ...V1_SCHEMA.properties, stars: { type: 'integer', maximum: 100 } },
    };
    const result = await submit(storage({ schema: widened }));
    expect(result.storageMigrationWarnings).toEqual([]);
    expect(dbMock.dbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(1);
  });

  it('🔴 the baseline is what the store enforces, not the latest approved request row', async () => {
    // The latest approved request already says V2, but app_blocks.manifest (enforced) is V1.
    const V2_MANIFEST = {
      blockId: SLUG,
      version: '1.5.0',
      storage: storage({ schema: V2_SCHEMA }),
    };
    dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([
      { id: 'pubreq_v2', manifest: V2_MANIFEST },
    ]);
    await expect(submit(storage({ schema: V2_SCHEMA }))).rejects.toThrow(
      'no migration covers them: cards "/status" required: false → true; cards "/stars" maximum: 10 → 5.'
    );
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });
});

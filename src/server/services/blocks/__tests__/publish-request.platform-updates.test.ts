import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
// Submit-time deep manifest validation is pinned in publish-request.submitValidation.test.ts;
// these fixtures are not full manifests, so that seam is a no-op here.
vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));
import type * as FliptClient from '~/server/flipt/client';

/**
 * STAFF PLATFORM UPDATES on the paths that file a publish request, through the real
 * `submitVersion` and `recordPendingFromPush`, the real check (`platform-update-bundle-check.ts`)
 * and the real record query text, over the canonical db mock (the query's own behaviour against
 * the migrations is pinned in platform-update-bundle-check.pglite.test.ts). MinIO and the git host
 * are stubbed: the app's source repo holds the update's two commits, the build repo the pushed one.
 *
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR: at origin/main a bundle (or a push) that lacks a staff
 * update no approved version has shipped is queued as if it had it, and nothing tells the
 * moderator. Every refusal and every record below fails there.
 */

const h = vi.hoisted(() => ({
  platformFlag: true,
  s3Send: vi.fn(),
  /** `${org ?? 'build'}@${ref}` → path → blob sha */
  trees: new Map<string, Map<string, string>>(),
  blobs: new Map<string, Buffer>(),
  /** The rows the platform-update query answers with; an Error is thrown instead. */
  updateRows: [] as unknown[] | Error,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: vi.fn(async (flag: string) =>
      flag === actual.FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES ? h.platformFlag : false
    ),
  };
});
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, username: `u${id}` })) },
}));
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'bundle-bucket-test',
  getBundleS3Client: () => ({ send: h.s3Send }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
  listRepoTreeAtRef: vi.fn(async (_slug: string, ref: string, org?: string) => {
    const tree = h.trees.get(`${org ?? 'build'}@${ref}`);
    if (!tree) throw new Error(`no tree ${org ?? 'build'}@${ref}`);
    return tree;
  }),
  getBlobContent: vi.fn(async (_slug: string, blobSha: string) => {
    const blob = h.blobs.get(blobSha);
    if (!blob) throw new Error(`no blob ${blobSha}`);
    return blob;
  }),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

const { submitVersion, recordPendingFromPush } = await import(
  '~/server/services/blocks/publish-request.service'
);
const { FORGEJO_SOURCE_ORG } = await import('~/server/services/blocks/forgejo-orgs');
// Loaded where used, so at origin/main (where it does not exist) every other case still runs and
// fails on BEHAVIOUR.
const reviewLines = async (fileSummary: unknown) =>
  (await import('~/components/Apps/reviewPlatformUpdates')).reviewPlatformUpdatesLines(fileSummary);

const SLUG = 'bundle-gate-int';
const APP = 'ab_bundle_gate_int';
const AUTHOR = 9301;
const BASE_SHA = 'b'.repeat(40);
const UPDATE_SHA = 'c'.repeat(40);
const PUSHED_SHA = 'd'.repeat(40);

const BASE_TEXT = 'export const a = 1;\n';
const UPDATE_TEXT = 'export const a = 1;\nexport const staffFix = true;\n';

const MESSAGE =
  'this bundle does not contain a platform update from Civitai staff that has not shipped yet: ' +
  'apu_int by mod-jane ("Fix the deprecated SDK call"): src/a.ts. Merge it into the app and ' +
  'submit again, or submit with --allow-unmerged-platform-update (allowUnmergedPlatformUpdate: ' +
  'true) to send it for review without it; the moderator is shown what was left out';
const MISSING = [
  { id: 'apu_int', reason: 'Fix the deprecated SDK call', by: 'mod-jane', paths: ['src/a.ts'] },
];
const RECORD = (via: 'override' | 'push') => ({
  via,
  updates: [{ id: 'apu_int', by: 'mod-jane', paths: ['src/a.ts'] }],
});

/** The record's row as the service's query returns it. */
const updateRow = (over: Record<string, unknown> = {}) => ({
  id: 'apu_int',
  appBlockId: APP,
  slug: SLUG,
  staffUserId: 51,
  reason: 'Fix the deprecated SDK call',
  branch: 'platform-update/apu_int',
  baseCommitSha: BASE_SHA,
  commitSha: UPDATE_SHA,
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

async function bundle(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'block.manifest.json',
    JSON.stringify({ blockId: SLUG, version: '2.0.0', name: 'Bundle Gate', contentRating: 'g' })
  );
  zip.file('index.html', '<!doctype html><html><body>gate</body></html>');
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const submit = async (files: Record<string, string>, extra: Record<string, unknown> = {}) =>
  submitVersion({
    bundleBuffer: await bundle(files),
    submittedByUserId: AUTHOR,
    // A moderator queueing a version of another account's app: the on-behalf path. An owner's
    // submit runs the same lines (the check comes after the owner gate either way).
    submitterIsModerator: true,
    ...extra,
  });

const rejection = (p: Promise<unknown>) =>
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

beforeEach(() => {
  vi.clearAllMocks();
  h.platformFlag = true;
  h.updateRows = [updateRow()];
  h.s3Send.mockResolvedValue({});
  h.blobs = new Map([
    ['blob-base', Buffer.from(BASE_TEXT)],
    ['blob-update', Buffer.from(UPDATE_TEXT)],
  ]);
  h.trees = new Map([
    [`${FORGEJO_SOURCE_ORG}@${BASE_SHA}`, new Map([['src/a.ts', 'blob-base']])],
    [`${FORGEJO_SOURCE_ORG}@${UPDATE_SHA}`, new Map([['src/a.ts', 'blob-update']])],
  ]);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: unknown) => {
    if (!JSON.stringify(sql).includes('app_platform_updates')) return [];
    if (h.updateRows instanceof Error) throw h.updateRows;
    return h.updateRows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue({ id: APP, appId: 'appblk-int' });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: AUTHOR } });
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.appBlockPublishRequest.findMany.mockResolvedValue([]);
  dbMock.dbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
});

describe('submitVersion — staff platform updates', () => {
  it('🔴 refuses a bundle missing an unshipped update: code, 409, message, details; nothing queued', async () => {
    const err = await rejection(submit({ 'src/a.ts': BASE_TEXT }));
    expect(err?.name).toBe('PlatformUpdateMissingRefusal');
    expect(err?.code).toBe('platform_update_missing');
    expect(err?.status).toBe(409);
    expect(err?.message).toBe(MESSAGE);
    expect(err?.details).toEqual({ updates: MISSING });
    expect(h.s3Send).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('🔴 with allowUnmergedPlatformUpdate: queued, recorded for the moderator, and an advisory', async () => {
    const result = await submit({ 'src/a.ts': BASE_TEXT }, { allowUnmergedPlatformUpdate: true });
    expect(createdFileSummary().platformUpdatesMissing).toEqual(RECORD('override'));
    expect(result.advisories).toContainEqual({
      code: 'platform-update-missing',
      message:
        'Submitted without a platform update from Civitai staff: apu_int by mod-jane ("Fix the ' +
        'deprecated SDK call"): src/a.ts. The moderator reviewing this version is shown what it left out.',
    });
    // The review line reads exactly what the submit wrote (writer → reader, one fixture).
    expect(await reviewLines(createdFileSummary())).toEqual([
      {
        key: 'platform-updates',
        heading: 'Missing platform updates (submitted with --allow-unmerged-platform-update)',
        value: 'apu_int by mod-jane: src/a.ts',
      },
    ]);
  });

  it('accepts a bundle that has the update’s exact file, and records nothing', async () => {
    const result = await submit({ 'src/a.ts': UPDATE_TEXT });
    expect(result.publishRequestId).toMatch(/^pubreq_/);
    expect(createdFileSummary()).not.toHaveProperty('platformUpdatesMissing');
    expect(result.advisories.map((a) => a.code)).not.toContain('platform-update-missing');
    // Positive control: the check did run (one query).
    expect(updateQueries()).toHaveLength(1);
  });

  it('accepts a hand-merged file that has every line the update adds', async () => {
    const merged =
      '// owner\nexport const a = 1;\nexport const owner = 3;\nexport const staffFix = true;\n';
    const result = await submit({ 'src/a.ts': merged });
    expect(result.publishRequestId).toMatch(/^pubreq_/);
    expect(createdFileSummary()).not.toHaveProperty('platformUpdatesMissing');
  });

  it('accepts a bundle that holds a delete update (the path gone)', async () => {
    h.updateRows = [updateRow({ paths: [{ path: 'src/a.ts', operation: 'delete' }] })];
    h.trees.set(`${FORGEJO_SOURCE_ORG}@${UPDATE_SHA}`, new Map());
    await expect(submit({ 'src/b.ts': 'b\n' })).resolves.toMatchObject({ slug: SLUG });
    // …and refuses one that still carries the deleted file.
    const err = await rejection(submit({ 'src/a.ts': BASE_TEXT }));
    expect(err?.code).toBe('platform_update_missing');
  });

  it('is off with the flag off: no query, the bundle is queued', async () => {
    h.platformFlag = false;
    await expect(submit({ 'src/a.ts': BASE_TEXT })).resolves.toMatchObject({ slug: SLUG });
    expect(updateQueries()).toHaveLength(0);
  });

  it('is off while the table is missing: the bundle is queued', async () => {
    h.updateRows = Object.assign(new Error('relation "app_platform_updates" does not exist'), {
      code: '42P01',
    });
    await expect(submit({ 'src/a.ts': BASE_TEXT })).resolves.toMatchObject({ slug: SLUG });
    expect(updateQueries()).toHaveLength(1);
  });

  it('a first version (no app yet) is not checked', async () => {
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
    await expect(submit({ 'src/a.ts': BASE_TEXT })).resolves.toMatchObject({ slug: SLUG });
    expect(updateQueries()).toHaveLength(0);
  });
});

describe('recordPendingFromPush — staff platform updates', () => {
  const push = () =>
    recordPendingFromPush({
      slug: SLUG,
      sha: PUSHED_SHA,
      appBlockId: APP,
      manifest: { blockId: SLUG, version: '2.0.0', name: 'Bundle Gate' },
      version: '2.0.0',
      pusherUserId: AUTHOR,
    });

  it('🔴 a push missing an update is recorded, not refused: the moderator record and an advisory', async () => {
    h.trees.set(`build@${PUSHED_SHA}`, new Map([['src/a.ts', 'blob-base']]));
    const result = await push();
    expect(result.publishRequestId).toMatch(/^pubreq_/);
    expect(createdFileSummary().platformUpdatesMissing).toEqual(RECORD('push'));
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
      Buffer.from(JSON.stringify({ blockId: SLUG, version: '2.0.0', name: 'Bundle Gate' }))
    );
    h.trees.set(
      `build@${PUSHED_SHA}`,
      new Map([
        ['block.manifest.json', 'blob-manifest'],
        ['src/a.ts', 'blob-base'],
      ])
    );
    await push();
    await vi.waitFor(() =>
      expect(dbMock.dbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fileSummary: expect.objectContaining({ platformUpdatesMissing: RECORD('push') }),
          }),
        })
      )
    );
  });

  it('a push that contains the update records nothing and says nothing', async () => {
    h.trees.set(`build@${PUSHED_SHA}`, new Map([['src/a.ts', 'blob-update']]));
    const result = await push();
    expect(createdFileSummary()).not.toHaveProperty('platformUpdatesMissing');
    expect(result.advisories).toEqual([]);
    expect(updateQueries()).toHaveLength(1);
  });
});

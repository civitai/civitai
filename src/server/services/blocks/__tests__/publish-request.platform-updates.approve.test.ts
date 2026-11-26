import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
import type * as FliptClient from '~/server/flipt/client';
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

/**
 * STAFF PLATFORM UPDATES at approve, through the real `approveRequest` (harness as in
 * `publish-request.notify.service.test.ts`): the approve re-checks the bytes it approves and marks
 * shipped, by this request, exactly the unshipped updates those bytes contain.
 *
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR: at origin/main nothing marks an update shipped, so once
 * the submit check exists every later submit of the app would be checked for it forever, and an
 * owner's own later edit to the same lines would be refused.
 */

const { db, s3, holder, h } = vi.hoisted(() => {
  const holder: { zipBytes: Uint8Array } = { zipBytes: new Uint8Array() };
  const h = {
    platformFlag: true,
    trees: new Map<string, Map<string, string>>(),
    blobs: new Map<string, Buffer>(),
    updateRows: [] as unknown[],
  };
  const makeDb = () => ({
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
    $executeRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        $executeRawUnsafe: async () => 0,
      })
    ),
    appBlockPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appBlock: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 'apb_existing' })),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    oauthClient: {
      findUnique: vi.fn(
        async (...a: unknown[]): Promise<unknown> =>
          (a[0] as { select?: { allowedScopes?: boolean } } | undefined)?.select?.allowedScopes
            ? { allowedScopes: 0n }
            : null
      ),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
    },
    appListing: {
      findUnique: vi.fn(
        async (..._a: unknown[]): Promise<unknown> => ({ id: 'apl_existing', kind: 'onsite' })
      ),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
  });
  const db = { read: makeDb(), write: makeDb() };
  db.write.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      ...db.write,
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      $executeRawUnsafe: async () => 0,
    })
  );
  const s3 = {
    send: vi.fn(async () => ({ Body: { transformToByteArray: async () => holder.zipBytes } })),
  };
  return { db, s3, holder, h };
});

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: vi.fn(async (flag: string) =>
      flag === actual.FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES ? h.platformFlag : false
    ),
  };
});
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async (): Promise<unknown[]> => [],
  bustCacheTag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-block-notify', () => ({
  notifyAppBlockSubmitter: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/client', () => ({ dbRead: db.read, dbWrite: db.write }));
vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok',
    FORGEJO_WEBHOOK_SECRET: 'sec',
    APPS_DOMAIN: 'apps.example',
    NEXTAUTH_URL: 'https://civitai.example',
  },
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newUlid: () => 'ULID000' }));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: {
    validate: () => ({ valid: true, errors: [] }),
    validateSubmission: vi.fn(async () => ({ valid: true, errors: [] })),
  },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  commitFiles: vi.fn(async () => ({ sha: 'deadbeefsha' })),
  setCommitStatus: vi.fn(async () => undefined),
  createRepoFromTemplate: vi.fn(async () => ({ html_url: 'https://forgejo.example/x' })),
  ensurePushWebhook: vi.fn(async () => undefined),
  ensureApprovalTag: vi.fn(async () => ({ status: 'created' })),
  listRepoTreeAtRef: vi.fn(async (_slug: string, ref: string, org?: string) => {
    const tree = h.trees.get(`${org ?? 'build'}@${ref}`);
    if (!tree) throw new Error(`no tree ${org ?? 'build'}@${ref}`);
    return tree;
  }),
  getBlobContent: vi.fn(async (_slug: string, sha: string) => {
    const blob = h.blobs.get(sha);
    if (!blob) throw new Error(`no blob ${sha}`);
    return blob;
  }),
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-mapper', () => ({
  mapAppBlockToListing: () => ({ id: 'apl_mapped' }),
  buildListingIssueTrackerSync: () => ({ write: false }),
  buildListingScalarSync: () => ({
    name: 'Cool App',
    description: null,
    tagline: null,
    category: null,
  }),
}));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => s3,
}));

const { approveRequest } = await import('~/server/services/blocks/publish-request.service');
const { FORGEJO_SOURCE_ORG } = await import('~/server/services/blocks/forgejo-orgs');

const BASE_SHA = 'b'.repeat(40);
const IN_SHA = 'c'.repeat(40);
const OUT_SHA = 'e'.repeat(40);
const BASE_TEXT = 'export const a = 1;\n';
const UPDATE_TEXT = 'export const a = 1;\nexport const staffFix = true;\n';

const row = (id: string, commitSha: string, path: string, operation = 'update') => ({
  id,
  appBlockId: 'apb_existing',
  slug: 'cool-app',
  staffUserId: 51,
  reason: 'Fix it',
  branch: `platform-update/${id}`,
  baseCommitSha: BASE_SHA,
  commitSha,
  paths: [{ path, operation }],
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
});

function pendingApproveRow() {
  return {
    id: 'req_appr_pu',
    status: 'pending',
    slug: 'cool-app',
    version: '1.2.0',
    manifest: { name: 'Cool App', scopes: [] },
    bundleKey: 'bundles/cool-app.zip',
    forgejoCommitSha: '',
    submittedByUserId: 4242,
    appBlockId: 'apb_existing',
    deployState: null,
  };
}

function existingAppBlock() {
  return {
    id: 'apb_existing',
    appId: 'app_1',
    repoUrl: 'https://forgejo.example/cool-app',
    trustTier: 'unverified',
    app: { allowedScopes: 0n, allowedOrigins: ['https://cool-app.apps.example'] },
  };
}

async function setBundle(files: Record<string, string>) {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify({ name: 'Cool App', scopes: [] }));
  zip.file('index.html', '<html></html>');
  for (const [p, c] of Object.entries(files)) zip.file(p, c);
  holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
}

/** The `shipped` UPDATEs approve ran: [ids, publishRequestId]. */
const shippedWrites = () =>
  (db.write.$executeRaw.mock.calls as unknown[][])
    .filter(([strings]) =>
      (strings as string[]).join('?').includes('shipped_in_publish_request_id')
    )
    .map(([, publishRequestId, ids]) => [ids, publishRequestId]);

const approve = async () => {
  db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
  db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
  return approveRequest({ publishRequestId: 'req_appr_pu', reviewerUserId: 9 });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.platformFlag = true;
  h.blobs = new Map([
    ['blob-base', Buffer.from(BASE_TEXT)],
    ['blob-in', Buffer.from(UPDATE_TEXT)],
    ['blob-out', Buffer.from('export {};\n')],
  ]);
  h.trees = new Map([
    [`${FORGEJO_SOURCE_ORG}@${BASE_SHA}`, new Map([['src/a.ts', 'blob-base']])],
    [`${FORGEJO_SOURCE_ORG}@${IN_SHA}`, new Map([['src/a.ts', 'blob-in']])],
    [
      `${FORGEJO_SOURCE_ORG}@${OUT_SHA}`,
      new Map([
        ['src/a.ts', 'blob-base'],
        ['src/new.ts', 'blob-out'],
      ]),
    ],
  ]);
  h.updateRows = [
    row('apu_in', IN_SHA, 'src/a.ts'),
    row('apu_out', OUT_SHA, 'src/new.ts', 'create'),
  ];
  db.write.$queryRaw.mockImplementation(async (sql: unknown) =>
    JSON.stringify(sql).includes('app_platform_updates') ? h.updateRows : []
  );
  db.write.$executeRaw.mockResolvedValue(1);
  db.write.appBlockPublishRequest.update.mockImplementation(
    async (a: { data?: unknown }) => a?.data ?? {}
  );
  db.write.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  db.write.appBlock.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
  db.write.appBlock.updateMany.mockResolvedValue({ count: 0 });
  db.write.appBlock.findUnique.mockResolvedValue({ id: 'apb_existing' });
  db.write.oauthClient.update.mockResolvedValue({});
  db.write.appListing.updateMany.mockResolvedValue({ count: 0 });
  db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_existing', kind: 'onsite' });
  s3.send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => holder.zipBytes },
  }));
});

describe('approveRequest — staff platform updates', () => {
  it('🔴 marks shipped, by this request, only the updates the approved bundle contains', async () => {
    await setBundle({ 'src/a.ts': UPDATE_TEXT });
    await approve();
    expect(shippedWrites()).toEqual([[['apu_in'], 'req_appr_pu']]);
  });

  it('marks nothing when the approved bundle contains none of them', async () => {
    await setBundle({ 'src/a.ts': BASE_TEXT });
    const result = await approve();
    expect(result.publishRequestId).toBe('req_appr_pu');
    expect(shippedWrites()).toEqual([]);
    // Positive control: the check ran against the record.
    expect(
      (db.write.$queryRaw.mock.calls as unknown[][]).filter(([sql]) =>
        JSON.stringify(sql).includes('app_platform_updates')
      )
    ).toHaveLength(1);
  });

  it('with the flag off, marks nothing and the approve stands', async () => {
    h.platformFlag = false;
    await setBundle({ 'src/a.ts': UPDATE_TEXT });
    const result = await approve();
    expect(result.publishRequestId).toBe('req_appr_pu');
    expect(shippedWrites()).toEqual([]);
  });

  it('never fails the approve: an unreadable source repo marks nothing', async () => {
    h.trees.delete(`${FORGEJO_SOURCE_ORG}@${IN_SHA}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await setBundle({ 'src/a.ts': UPDATE_TEXT });
    const result = await approve();
    expect(result.publishRequestId).toBe('req_appr_pu');
    expect(shippedWrites()).toEqual([]);
    warn.mockRestore();
  });
});

import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { DocStore, DocStoreMaintenance } from '~/server/services/apps/doc-store';
import type * as RuntimeMetrics from '~/server/metrics/app-block-runtime.metrics';

/**
 * Review document-store data is deleted inline when a moderator or owner DECIDES a publish
 * request: approve, reject, owner withdraw. (Supersedes, failures and stragglers are the
 * sweep's: `src/server/jobs/__tests__/sweep-review-storage.test.ts`.)
 *
 * The decision paths run for real against an in-memory `app_block_publish_requests` table
 * (their other DB reads answer empty, and the build/forgejo/notification edges are stubbed as
 * in `publish-request.notify.service.test.ts`); the DOCUMENT STORE is real — the embedded
 * Postgres running the real migration as the least-privilege role with row-level security on —
 * so "deleted" is read back from the tables, not from a spy.
 */

type Req = {
  id: string;
  slug: string;
  status: string;
  version?: string;
  manifest?: unknown;
  bundleKey?: string;
  forgejoCommitSha?: string;
  submittedByUserId: number;
  appBlockId?: string | null;
  deployState?: string | null;
};

const h = vi.hoisted(() => ({
  requests: new Map<string, Req>(),
  store: undefined as unknown as DocStore,
  maint: undefined as unknown as DocStoreMaintenance,
  zipBytes: new Uint8Array(),
  outcomes: [] as string[],
}));

/** `where` as the decision paths write it: id, slug, status, forgejoCommitSha, NOT: { id }. */
function matches(r: Req, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'NOT') {
      if (r.id === (v as { id: string }).id) return false;
    } else if ((r as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

const requestsModel = {
  findUnique: async ({ where }: { where: { id: string } }) => {
    const r = h.requests.get(where.id);
    return r ? { ...r } : null;
  },
  findFirst: async ({ where }: { where: Record<string, unknown> }) =>
    [...h.requests.values()].find((r) => matches(r, where)) ?? null,
  findMany: async ({ where }: { where: Record<string, unknown> }) =>
    [...h.requests.values()].filter((r) => matches(r, where)).map((r) => ({ id: r.id })),
  update: async ({ where, data }: { where: { id: string }; data: Partial<Req> }) => {
    const r = h.requests.get(where.id);
    if (!r) throw new Error(`no request ${where.id}`);
    Object.assign(r, data);
    return { ...r };
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Req> }) => {
    let count = 0;
    for (const r of h.requests.values()) {
      if (matches(r, where)) {
        Object.assign(r, data);
        count += 1;
      }
    }
    return { count };
  },
  create: async ({ data }: { data: Req }) => {
    h.requests.set(data.id, { ...data });
    return data;
  },
};

/** The in-memory table behind both clients, plus the two other rows the approve path reads. */
function installDb() {
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    const pr = client.appBlockPublishRequest;
    // mockReset drops any `…Once` value a previous test queued but did not consume.
    pr.findUnique.mockReset();
    pr.findUnique.mockImplementation(requestsModel.findUnique);
    pr.findFirst.mockImplementation(requestsModel.findFirst);
    pr.findMany.mockImplementation(requestsModel.findMany);
    pr.update.mockImplementation(requestsModel.update);
    pr.updateMany.mockImplementation(requestsModel.updateMany);
    pr.create.mockImplementation(requestsModel.create);
    client.appBlock.findFirst.mockResolvedValue(existingAppBlock);
    client.appBlock.findUnique.mockResolvedValue(existingAppBlock);
    client.appBlock.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
    client.appBlock.updateMany.mockResolvedValue({ count: 0 });
    client.oauthClient.update.mockResolvedValue({});
    client.appListing.findUnique.mockResolvedValue({ id: 'apl_existing', kind: 'onsite' });
    client.appListing.updateMany.mockResolvedValue({ count: 0 });
  }
}

const existingAppBlock = {
  id: 'apb_existing',
  appId: 'app_1',
  repoUrl: 'https://forgejo.example/cool-app',
  trustTier: 'unverified',
  app: { allowedScopes: 0, allowedOrigins: ['https://cool-app.apps.example'], userId: 4242 },
};

vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => h.maint,
}));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeMetrics>()),
  recordReviewStorageCleanup: (outcome: string) => {
    h.outcomes.push(outcome);
  },
}));
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
  listRepoTreeAtRef: vi.fn(async () => new Map()),
  getBlobContent: vi.fn(async () => Buffer.from('')),
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(async () => undefined),
  deleteReviewResources: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-mapper', () => ({
  mapAppBlockToListing: () => ({ id: 'apl_mapped' }),
  buildListingScalarSync: () => ({
    name: 'Cool App',
    description: null,
    tagline: null,
    category: null,
  }),
}));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => ({
    send: async () => ({ Body: { transformToByteArray: async () => h.zipBytes } }),
  }),
  deleteStagedBundle: async () => undefined,
}));

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { createDocStore, createDocStoreMaintenance, reviewNamespace } = await import(
  '~/server/services/apps/doc-store'
);
const { createPgliteHarness } = await import('~/server/services/apps/__tests__/doc-store.harness');
const { PREFS, POSTS, TALLIES, ctx } = await import(
  '~/server/services/apps/__tests__/doc-store.functional'
);
const { APPDATA_TABLES } = await import('~/server/services/apps/__tests__/doc-store.sql-scan');
const { approveRequest, rejectRequest, withdrawRequest, teardownReviewStorageForRequest } =
  await import('~/server/services/blocks/publish-request.service');

type Harness = Awaited<ReturnType<typeof createPgliteHarness>>;
let harness: Harness;
let liveStore: DocStore;
let liveMaint: DocStoreMaintenance;

const SUBMITTER = 4242;
const MODS = [5_101, 5_202];
let seq = 0;

function pending(slug: string, extra: Partial<Req> = {}): Req {
  seq += 1;
  const r: Req = {
    id: `pubreq_CLEANUP${seq}`,
    slug,
    status: 'pending',
    version: '1.2.0',
    manifest: { name: 'Cool App', scopes: [] },
    bundleKey: 'bundles/cool-app.zip',
    forgejoCommitSha: '',
    submittedByUserId: SUBMITTER,
    appBlockId: 'apb_existing',
    deployState: null,
    ...extra,
  };
  h.requests.set(r.id, r);
  return r;
}

/** Both moderators write a private doc, a shared doc, a mark and a counter in their namespaces. */
async function seedReview(publishRequestId: string) {
  for (const uid of MODS) {
    const c = ctx(publishRequestId, reviewNamespace(publishRequestId, uid), uid);
    await liveStore.put(c, PREFS, 'k', { uid });
    await liveStore.put(c, POSTS, 'p', { status: 'open' });
    await liveStore.mark(c, POSTS, 'p', 'vote');
    await liveStore.increment(c, TALLIES, 'g', 'plays', 2);
  }
}

/** Rows of this request in every appdata table, all namespaces. */
async function rows(publishRequestId: string): Promise<number> {
  let n = 0;
  for (const t of APPDATA_TABLES) {
    const [r] = await harness.raw(`SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1`, [
      publishRequestId,
    ]);
    n += Number(r.n);
  }
  return n;
}

async function expectPurged(publishRequestId: string) {
  await vi.waitFor(async () => expect(await rows(publishRequestId)).toBe(0), {
    timeout: 10_000,
    interval: 20,
  });
}

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true });
  liveStore = createDocStore({ db: harness.db });
  liveMaint = createDocStoreMaintenance({ db: harness.db });
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify({ name: 'Cool App', scopes: [] }));
  zip.file('index.html', '<html></html>');
  h.zipBytes = await zip.generateAsync({ type: 'uint8array' });
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  installDb();
  h.requests.clear();
  h.outcomes.length = 0;
  h.store = liveStore;
  h.maint = liveMaint;
});

describe('review storage is deleted inline when a request is decided', () => {
  it('reject: every moderator namespace of the request is gone; another request is untouched', async () => {
    const pr = pending('rej-app');
    const bystander = pending('other-app');
    await seedReview(pr.id);
    await seedReview(bystander.id);
    const bystanderRows = await rows(bystander.id);
    // Positive control: both moderators' rows exist.
    expect(await rows(pr.id)).toBe(bystanderRows);
    expect(bystanderRows).toBeGreaterThan(10);

    await rejectRequest({
      publishRequestId: pr.id,
      reviewerUserId: MODS[0],
      rejectionReason: 'Uses a disallowed scope',
    });

    expect(h.requests.get(pr.id)?.status).toBe('rejected');
    await expectPurged(pr.id);
    expect(await rows(bystander.id)).toBe(bystanderRows);
  });

  it('approve', async () => {
    const pr = pending('cool-app');
    await seedReview(pr.id);

    await approveRequest({ publishRequestId: pr.id, reviewerUserId: MODS[0] });

    expect(h.requests.get(pr.id)?.status).toBe('approved');
    await expectPurged(pr.id);
  });

  it('approve whose build trigger fails: the request stays approved, and its review data still goes', async () => {
    const pr = pending('cool-app');
    await seedReview(pr.id);
    const pipeline = await import('~/server/services/blocks/apps-pipeline.service');
    vi.mocked(pipeline.triggerBuild).mockRejectedValueOnce(new Error('build system unavailable'));

    await expect(
      approveRequest({ publishRequestId: pr.id, reviewerUserId: MODS[0] })
    ).rejects.toThrow(/build trigger failed/);

    expect(h.requests.get(pr.id)?.status).toBe('approved');
    await expectPurged(pr.id);
  });

  it('owner withdraw', async () => {
    const pr = pending('wd-app');
    await seedReview(pr.id);

    await withdrawRequest({ publishRequestId: pr.id, userId: SUBMITTER });

    expect(h.requests.get(pr.id)?.status).toBe('withdrawn');
    await expectPurged(pr.id);
  });

  it('owner withdraw that loses the race to a concurrent withdraw (the count === 0 branch)', async () => {
    const pr = pending('wd-race-app', { status: 'withdrawn' });
    await seedReview(pr.id);
    // The classify read still saw `pending`; the guarded update then matches nothing.
    dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pr,
      status: 'pending',
    });

    await expect(
      withdrawRequest({ publishRequestId: pr.id, userId: SUBMITTER })
    ).resolves.toBeUndefined();

    await expectPurged(pr.id);
  });
});

describe('teardownReviewStorageForRequest', () => {
  it('a cleanup FAILURE never blocks the decision, is counted, and a later call (the sweep) finishes it', async () => {
    const pr = pending('fail-app');
    await seedReview(pr.id);
    const before = await rows(pr.id);
    h.maint = createDocStoreMaintenance({
      db: {
        connect: async () => {
          throw new Error('appdata unreachable');
        },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      rejectRequest({
        publishRequestId: pr.id,
        reviewerUserId: MODS[0],
        rejectionReason: 'Uses a disallowed scope',
      })
    ).resolves.toBeUndefined();
    expect(h.requests.get(pr.id)?.status).toBe('rejected');
    await vi.waitFor(() =>
      expect(
        warn.mock.calls.some(
          (c) =>
            String(c[0]).includes(`cleanup failed (id=${pr.id})`) &&
            String(c[0]).includes('appdata unreachable')
        )
      ).toBe(true)
    );
    warn.mockRestore();
    expect(await rows(pr.id)).toBe(before);

    // A direct call against the same unreachable store: counted as failed, never thrown.
    h.outcomes.length = 0;
    await expect(teardownReviewStorageForRequest(pr.id)).resolves.toBeUndefined();
    expect(h.outcomes).toEqual(['failed']);

    // A later purge finishes it…
    h.maint = liveMaint;
    await teardownReviewStorageForRequest(pr.id);
    expect(await rows(pr.id)).toBe(0);
    expect(h.outcomes).toEqual(['failed', 'purged']);
    // …and is idempotent.
    await teardownReviewStorageForRequest(pr.id);
    expect(h.outcomes).toEqual(['failed', 'purged', 'nothing']);
  });

  it('no store connection: counted as disabled, never thrown', async () => {
    const pr = pending('nodb-app', { status: 'rejected' });
    h.maint = createDocStoreMaintenance({ db: null });
    await expect(teardownReviewStorageForRequest(pr.id)).resolves.toBeUndefined();
    expect(h.outcomes).toEqual(['disabled']);
  });
});

describe('civitai_app_block_review_storage_cleanup_total', () => {
  it('the real recorder increments the labelled series', async () => {
    const real = await vi.importActual<typeof RuntimeMetrics>(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const prom = await import('prom-client');
    const read = async (outcome: string) => {
      const metric = prom.register.getSingleMetric(
        'civitai_app_block_review_storage_cleanup_total'
      );
      const values = metric ? (await metric.get()).values : [];
      return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
    };
    real.recordReviewStorageCleanup('failed');
    real.recordReviewStorageCleanup('purged');
    const before = { failed: await read('failed'), purged: await read('purged') };
    real.recordReviewStorageCleanup('failed');
    real.recordReviewStorageCleanup('purged');
    real.recordReviewStorageCleanup('purged');
    expect({ failed: await read('failed'), purged: await read('purged') }).toEqual({
      failed: before.failed + 1,
      purged: before.purged + 2,
    });
    expect(before.failed).toBeGreaterThanOrEqual(1);
    expect(before.purged).toBeGreaterThanOrEqual(1);
  });
});

describe('civitai_app_block_review_storage_sweep_total', () => {
  it('the real recorder increments the labelled series', async () => {
    const real = await vi.importActual<typeof RuntimeMetrics>(
      '~/server/metrics/app-block-runtime.metrics'
    );
    const prom = await import('prom-client');
    const read = async (outcome: string) => {
      const metric = prom.register.getSingleMetric('civitai_app_block_review_storage_sweep_total');
      const values = metric ? (await metric.get()).values : [];
      return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
    };
    real.recordReviewStorageSweep('failed');
    real.recordReviewStorageSweep('purged');
    const before = { failed: await read('failed'), purged: await read('purged') };
    real.recordReviewStorageSweep('purged');
    real.recordReviewStorageSweep('purged');
    real.recordReviewStorageSweep('failed');
    expect({ failed: await read('failed'), purged: await read('purged') }).toEqual({
      failed: before.failed + 1,
      purged: before.purged + 2,
    });
    expect(before.failed).toBeGreaterThanOrEqual(1);
  });
});

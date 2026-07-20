import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

/**
 * Orchestration coverage for the W1 publish-request service. The existing
 * publish-request.service.test.ts covers the pure helpers (extract / diff);
 * THIS file exercises the DB+S3+Forgejo-coordinating functions:
 *   - submitVersion
 *   - withdrawRequest
 *   - listPendingRequests
 *   - approveRequest
 *   - rejectRequest
 *   - backfillPublishRequest
 *
 * Mocking strategy mirrors the buzz-attribution + checkpoint tests:
 *   - vi.hoisted() carries the mock surfaces so vi.mock factories can refer
 *     to them safely (the factory bodies hoist to the top of the file
 *     before imports run).
 *   - ~/server/db/client is mocked with the dbRead / dbWrite surfaces the
 *     service touches.
 *   - ~/utils/bundle-s3 is mocked to swallow S3 puts and serve a buffer
 *     back on get (the buffer is set per-test).
 *   - ./forgejo.service is mocked at the module boundary (createRepo,
 *     ensurePushWebhook, commitFiles, listRepoTree, getBlobContent, getRepo).
 *   - ~/server/utils/app-block-ids.newUlid is mocked deterministic so
 *     assertions can hit the generated ids by value.
 *   - global.fetch is mocked for the Discord webhook path.
 */

const {
  mockDbRead,
  mockDbWrite,
  mockS3Send,
  mockBundleBuffer,
  mockForgejo,
  mockTriggerBuild,
  mockUlidSeq,
  mockNewUlid,
  mockAplSeq,
  mockNewAppListingId,
  mockProvision,
} = vi.hoisted(() => {
  const ulidSeq: { i: number } = { i: 0 };
  // Dedicated counter for AppListing ids so minting a listing id does NOT
  // advance the shared ULID sequence that AppBlock/publish-request ids key off.
  const aplSeq: { i: number } = { i: 0 };
  return {
    mockDbRead: {
      appBlockPublishRequest: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      // `findUnique` added: recordPendingFromPush resolves the app owner's
      // userId via dbRead.appBlock.findUnique({ app: { userId } }).
      appBlock: { findFirst: vi.fn(), findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
      // Added 2026-05-28 for C-2 fix: approveRequest now reads the
      // OauthClient row after a P2002 collision to recover the existing
      // client on retry.
      oauthClient: { findUnique: vi.fn() },
      // W13 auto-create-on-approve: approveRequest checks for an existing onsite
      // AppListing (idempotency, keyed on appBlockId) before creating one.
      appListing: { findUnique: vi.fn(), findFirst: vi.fn(async () => null) },
      // Fix #1 (onsite): withdrawRequest probes the listing's latest mod event to
      // decide whether a reset withdraw closes the listing. Null → no reset in flight.
      appListingModerationEvent: { findFirst: vi.fn(async () => null) },
    },
    mockDbWrite: {
      // `updateMany` added (no-trust-on-push fix): approveRequest now supersedes
      // any stray pending review request the git-push webhook may have parked for
      // the slug while racing the approve commit.
      // `findUnique` added (S1 TOCTOU fix): withdrawRequest re-reads the row from
      // the PRIMARY when its status-guarded updateMany matches 0 rows, to resolve
      // a lost race without being fooled by replica lag.
      // `findFirst` added: recordPendingFromPush reads the existing pending row
      // for (slug,sha) off the PRIMARY (existingForSha refresh + the P2002
      // race re-read of the winner) via dbWrite.
      appBlockPublishRequest: {
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      // `findUnique` added (W13 auto-create-on-approve): approveRequest re-reads
      // the freshly-approved AppBlock's own columns off the PRIMARY to map it into
      // the onsite AppListing (same projection the backfill selects).
      // `updateMany` added (W13 category-on-approve): approveRequest copies a
      // validated manifest `category` onto AppBlock.category via a targeted,
      // no-clobber `updateMany` (gated on category=null) right before the (3b)
      // listing-create re-read.
      appBlock: {
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findUnique: vi.fn(),
      },
      // `update` added 2026-06-02 (audit A1 fix): approveRequest now re-caps
      // the app-block OauthClient's allowedScopes to the manifest-derived
      // ceiling + forces grants:[] on the subsequent-version + P2002-retry
      // paths.
      oauthClient: { create: vi.fn(), update: vi.fn() },
      // W13 auto-create-on-approve: approveRequest mints the onsite AppListing
      // (idempotent skip-if-exists, P2002-tolerant) right after the AppBlock row
      // exists so the app appears on the /apps grid without a manual backfill.
      // `updateMany` (W13 onsite reset re-approve): approveRequest restores a reset
      // (`pending`) onsite listing back to `approved`; default 0-count no-op.
      appListing: { create: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
      // Fix #1 (onsite) withdraw close: the reset-withdraw path flips the listing
      // pending→removed + writes a delist event inside a tx. `$transaction` is wired
      // post-hoist (below) to run its callback against this same write mock.
      appListingModerationEvent: { create: vi.fn(async () => ({})) },
      $transaction: vi.fn(),
    },
    mockS3Send: vi.fn(),
    mockBundleBuffer: { current: null as Buffer | null },
    mockForgejo: {
      createRepoFromTemplate: vi.fn(),
      ensurePushWebhook: vi.fn(),
      commitFiles: vi.fn(),
      listRepoTree: vi.fn(),
      // listRepoTreeAtRef — used by reconstructBundleFromForgejo (the
      // push-originated approve path + backfill). Resolves a commit SHA / ref
      // directly to its blob tree (no branch→commit lookup).
      listRepoTreeAtRef: vi.fn(),
      getBlobContent: vi.fn(),
      getRepo: vi.fn(),
      ensureReviewRepo: vi.fn(),
      // setCommitStatus added (no-trust-on-push fix): approveRequest now drives
      // the build trigger itself + pends/marks the commit status.
      setCommitStatus: vi.fn(),
      reviewRepoUrl: vi.fn((slug: string) => `https://forgejo.example/civitai-apps-review/${slug}`),
      // repoCommitUrl — used by the list payloads' pushCommitUrl (links a
      // push-originated review to the canonical repo at the pushed sha).
      repoCommitUrl: vi.fn(
        (slug: string, ref: string) => `https://forgejo.example/civitai-apps/${slug}/src/commit/${ref}`
      ),
    },
    // apps-pipeline.service.triggerBuild — approveRequest now triggers the
    // Tekton build directly (the git-push webhook no longer does). Mocked so
    // approve tests don't reach the real cross-cluster HTTP client.
    mockTriggerBuild: vi.fn(async () => ({ name: 'pipelinerun-mock' })),
    mockUlidSeq: ulidSeq,
    mockNewUlid: vi.fn(() => {
      ulidSeq.i += 1;
      // 26-char placeholder ending in a stable counter so tests can match
      return `00000000000000000000000${String(ulidSeq.i).padStart(3, '0')}`;
    }),
    mockAplSeq: aplSeq,
    // The mapper (app-listing-mapper) calls newAppListingId; the module mock
    // below must provide it (deterministic so listing-id assertions can match).
    mockNewAppListingId: vi.fn(() => {
      aplSeq.i += 1;
      return `apl_test_${aplSeq.i}`;
    }),
    // W4 storage-provision-on-approve: approveRequest dynamically imports
    // AppStorageProvisioner and calls provision() for a storage-declaring app so
    // its appsDb schema exists at approve (no manual admin backfill). Mocked so
    // the approve tests never reach the real cnpg-cluster-apps DDL path.
    mockProvision: vi.fn(async () => undefined),
  };
});

// Wire the write mock's interactive transaction to run its callback against the same
// mock (so tx-scoped writes in the withdraw reset-close land on these spies). Done
// post-hoist to avoid referencing `mockDbWrite` inside its own hoisted factory.
(mockDbWrite.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDbWrite)
);

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'app-block-bundles',
  getBundleS3Client: () => ({ send: mockS3Send }),
}));

// publish-request.service does `await import('./forgejo.service')` — vi.mock
// resolves the path relative to the IMPORTING module, so we mock the resolved
// absolute id that the service sees.
vi.mock('~/server/services/blocks/forgejo.service', () => mockForgejo);

// approveRequest does `await import('./apps-pipeline.service')` to trigger the
// Tekton build directly (no-trust-on-push: the git-push webhook no longer
// triggers builds). Mock the resolved absolute id the service sees.
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: mockTriggerBuild,
}));

// approveRequest does `await import('~/server/services/apps/storage-provision.service')`
// to provision the app's appsDb schema (W4). Mock the resolved id the service
// sees so the (3c) block never touches the real appsDb/pg module graph.
vi.mock('~/server/services/apps/storage-provision.service', () => ({
  AppStorageProvisioner: { provision: mockProvision },
}));

vi.mock('~/server/utils/app-block-ids', () => ({
  newUlid: mockNewUlid,
  newAppListingId: mockNewAppListingId,
  // Fix #1 (onsite) withdraw close writes a delist moderation event.
  newAppListingModerationEventId: () => 'alme_reset_close',
}));

// Override the global env mock with the keys submitVersion / approveRequest /
// notifyModsOfNewRequest read. The setup.ts proxy returns undefined for
// anything not whitelisted; we preserve the proxy fallback for keys we don't
// explicitly set (e.g. LOGGING is an array read at db-client module init).
const _publishEnvOverrides: Record<string, unknown> = {
  NEXTAUTH_URL: 'https://example.test',
  DISCORD_WEBHOOK_MOD_ALERTS: 'https://discord.example/hook',
  FORGEJO_BASE_URL: 'https://forgejo.example',
  FORGEJO_ADMIN_TOKEN: 'tok-test',
  FORGEJO_WEBHOOK_SECRET: 'sec-test',
  APPS_DOMAIN: 'civit.ai',
  BUNDLE_S3_ENDPOINT: 'http://minio.test',
  BUNDLE_S3_BUCKET: 'app-block-bundles',
  BUNDLE_S3_ACCESS_KEY_ID: 'key',
  BUNDLE_S3_SECRET_ACCESS_KEY: 'sec',
  LOGGING: [], // db-client.ts reads env.LOGGING.filter(); must be an array
};
vi.mock('~/env/server', () => ({
  env: new Proxy(_publishEnvOverrides, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return undefined;
    },
  }),
}));

// ---- helpers ---------------------------------------------------------------

const MANIFEST_PATH = 'block.manifest.json';

async function makeBundle(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

function manifest(over: Record<string, unknown> = {}) {
  // Default shape covers the minimum fields BlockManifestValidator requires
  // (so approveRequest's H-4 pre-validation accepts the manifest by default
  // and individual tests opt into invalid shapes via `over`).
  return {
    blockId: 'hello',
    version: '0.1.0',
    name: 'Hello World',
    contentRating: 'g',
    scopes: [],
    iframe: {
      src: 'https://hello.civit.ai',
      minHeight: 300,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts',
    },
    ...over,
  };
}

async function makeValidBundle(over: Record<string, unknown> = {}): Promise<Buffer> {
  return makeBundle({
    [MANIFEST_PATH]: JSON.stringify(manifest(over)),
    'index.html': '<!doctype html><html><body>hi</body></html>',
    Dockerfile: 'FROM node:20',
  });
}

beforeEach(() => {
  // M-2 manifests here: publish-request.service uses raw `process.env.NEXTAUTH_URL`
  // for the review URL embedded in the Discord notify (and the git-push webhook
  // callback URL in approveRequest), not the typed `env` import. Inject it so
  // the URL assertions work.
  process.env.NEXTAUTH_URL = 'https://example.test';
  mockUlidSeq.i = 0;
  mockAplSeq.i = 0;
  for (const surface of [mockDbRead, mockDbWrite, mockForgejo]) {
    for (const key of Object.keys(surface)) {
      const grp = (surface as Record<string, Record<string, unknown>>)[key];
      if (typeof grp === 'object' && grp !== null) {
        for (const fnName of Object.keys(grp)) {
          const fn = grp[fnName];
          if (typeof fn === 'function' && 'mockReset' in (fn as any)) {
            (fn as any).mockReset();
          }
        }
      } else if (typeof grp === 'function' && 'mockReset' in (grp as any)) {
        (grp as any).mockReset();
      }
    }
  }
  mockS3Send.mockReset();
  mockBundleBuffer.current = null;
  mockNewUlid.mockClear();

  // Defaults for the no-trust-on-push surfaces approveRequest now drives.
  // (The reset loop above strips implementations, so these would otherwise
  // return undefined and break `await`/`.catch()` chains in the service.)
  mockForgejo.setCommitStatus.mockResolvedValue(undefined);
  mockTriggerBuild.mockClear();
  mockTriggerBuild.mockResolvedValue({ name: 'pipelinerun-mock' });
  // W4 storage-provision-on-approve default: provision() resolves cleanly. Tests
  // that exercise the failure path override with mockRejectedValueOnce.
  mockProvision.mockReset();
  mockProvision.mockResolvedValue(undefined);
  mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
  mockDbWrite.appBlock.update.mockResolvedValue(undefined);
  // W13 category-on-approve default: the no-clobber category `updateMany` is a
  // no-op unless a test opts in (the default manifest declares no category).
  mockDbWrite.appBlock.updateMany.mockResolvedValue({ count: 0 });

  // Default: no pending conflict, no existing app block, user lookup OK.
  mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  mockDbRead.appBlock.findFirst.mockResolvedValue(null);
  mockDbRead.user.findUnique.mockResolvedValue({ username: 'tester' });
  mockDbWrite.appBlockPublishRequest.create.mockResolvedValue({ id: 'will-be-overwritten' });

  // W13 auto-create-on-approve defaults: no pre-existing listing (so the happy
  // path creates one), the freshly-approved AppBlock re-read echoes a hosted
  // (externalUrl=null) row derived from the default manifest, and create() echoes
  // the generated id back.
  mockDbRead.appListing.findUnique.mockResolvedValue(null);
  mockDbWrite.appBlock.findUnique.mockImplementation(
    async (args: { where: { id: string } }) => ({
      id: args.where.id,
      blockId: 'hello',
      manifest: manifest(),
      contentRating: 'g',
      category: null,
      featured: false,
      featuredOrder: null,
      externalUrl: null,
      app: { userId: 42 },
    })
  );
  mockDbWrite.appListing.create.mockImplementation(
    async (args: { data: { id: string } }) => ({ id: args.data.id })
  );

  // S3 default no-op for PUT; GET returns whatever mockBundleBuffer.current is set to.
  mockS3Send.mockImplementation(async (cmd: { input?: { Key?: string } }) => {
    const cmdName = cmd.constructor.name;
    if (cmdName === 'GetObjectCommand') {
      if (!mockBundleBuffer.current) {
        throw new Error('mock S3 GET: mockBundleBuffer.current not set');
      }
      const buf = mockBundleBuffer.current;
      return {
        Body: {
          transformToByteArray: async () =>
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        },
      };
    }
    return {};
  });

  // Mock fetch (Discord webhook) to never fail by default.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200 } as Response))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- submitVersion ---------------------------------------------------------

describe('submitVersion', () => {
  it('happy path — first version inserts a pending row with computed diffs', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle();

    const result = await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 42,
    });

    expect(result.publishRequestId).toMatch(/^pubreq_/);
    expect(result.slug).toBe('hello');
    expect(result.version).toBe('0.1.0');
    expect(result.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifestDiffSummary.kind).toBe('first-version');

    // DB write happened with the right shape.
    expect(mockDbWrite.appBlockPublishRequest.create).toHaveBeenCalledOnce();
    const createArg = mockDbWrite.appBlockPublishRequest.create.mock.calls[0][0];
    expect(createArg.data.status).toBe('pending');
    expect(createArg.data.slug).toBe('hello');
    expect(createArg.data.submittedByUserId).toBe(42);
    expect(createArg.data.appBlockId).toBeNull();
    expect(createArg.data.bundleKey).toMatch(/^bundles\/[0-9a-f]{64}\.zip$/);
    expect(typeof createArg.data.bundleSizeBytes).toBe('bigint');

    // S3 PUT happened before the DB insert.
    const putCalls = mockS3Send.mock.calls.filter(
      (c) => c[0].constructor.name === 'PutObjectCommand'
    );
    expect(putCalls).toHaveLength(1);
  });

  it('happy path — subsequent version links to existing AppBlock', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlock.findFirst.mockResolvedValue({ id: 'apb_existing', appId: 'oc_existing' });
    // Pretend prior approved publish_request exists with a stored file map.
    const priorFiles = [
      { path: 'Dockerfile', sha256: 'oldhash', sizeBytes: 100 },
      { path: 'block.manifest.json', sha256: 'oldhash2', sizeBytes: 80 },
      { path: 'index.html', sha256: 'oldhash3', sizeBytes: 50 },
    ];
    // First findFirst is pending check (null). Second is getPreviousApprovedState.
    mockDbRead.appBlockPublishRequest.findFirst
      .mockResolvedValueOnce(null) // pending check
      .mockResolvedValueOnce({
        manifest: manifest({ version: '0.0.9' }),
        fileSummary: { files: priorFiles, added: [], removed: [], changed: [] },
      }); // previous approved

    const buf = await makeValidBundle();
    const result = await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 42,
    });

    expect(result.manifestDiffSummary.kind).toBe('update');
    const createArg = mockDbWrite.appBlockPublishRequest.create.mock.calls[0][0];
    expect(createArg.data.appBlockId).toBe('apb_existing');
  });

  it('rejects when bundle exceeds 50 MiB', async () => {
    const { submitVersion } = await import('../publish-request.service');
    // 50 MiB + 1 byte
    const oversize = Buffer.alloc(50 * 1024 * 1024 + 1);
    await expect(
      submitVersion({
        bundleBuffer: oversize,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/bundle is \d+ bytes \(max 52428800\)/);

    expect(mockDbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects when bundle is empty', async () => {
    const { submitVersion } = await import('../publish-request.service');
    await expect(
      submitVersion({
        bundleBuffer: Buffer.alloc(0),
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/empty/);
  });

  it('rejects when manifest.blockId is not a valid slug', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({ blockId: 'NotALowercaseSlug' });
    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/manifest\.blockId .* lowercase/);
  });

  it('rejects when manifest.version is not valid semver', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({ version: 'not-semver' });
    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/manifest\.version .* semver/);
  });

  it('rejects when manifest.name is missing or empty', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({ name: '' });
    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/name must be a non-empty string/);
  });

  // ---- iframe.src is PLATFORM-OWNED: the developer never authors it. submit
  // DERIVES + stamps the canonical per-app subdomain root, overwriting whatever
  // the dev shipped (or omitted). The deep BlockManifestValidator at approve
  // still validates the stamped value against OauthClient.allowedOrigins. (Was:
  // submit hard-rejected a non-canonical iframe.src after the upload.)

  // Pull the manifest that submitVersion persisted into the publish_request row.
  function persistedManifest(): Record<string, any> {
    const call = mockDbWrite.appBlockPublishRequest.create.mock.calls.at(-1);
    return (call?.[0] as any).data.manifest as Record<string, any>;
  }

  it('stamps the canonical iframe.src when the manifest omits it', async () => {
    const { submitVersion } = await import('../publish-request.service');
    // iframe present but no src (dev only set sizing) — and a bundle with no
    // iframe object at all both resolve to the canonical root.
    const buf = await makeValidBundle({ iframe: { minHeight: 300 } });
    const result = await submitVersion({ bundleBuffer: buf, submittedByUserId: 42 });
    expect(result.publishRequestId).toBeDefined();
    expect(persistedManifest().iframe.src).toBe('https://hello.civit.ai/');
    // Other dev-authored iframe fields are preserved.
    expect(persistedManifest().iframe.minHeight).toBe(300);
  });

  it('overwrites a dev-supplied non-canonical iframe.src (http / wrong host / path)', async () => {
    const { submitVersion } = await import('../publish-request.service');
    for (const src of [
      'http://hello.civit.ai/',
      'https://attacker.example/',
      'https://blocks-pr2319.civitaic.com/hello/',
      'https://hello.civit.ai/hello/',
      'not a url',
    ]) {
      mockDbWrite.appBlockPublishRequest.create.mockClear();
      const buf = await makeValidBundle({
        iframe: { src, minHeight: 300, sandbox: 'allow-scripts' },
      });
      const result = await submitVersion({ bundleBuffer: buf, submittedByUserId: 42 });
      expect(result.publishRequestId).toBeDefined();
      // src normalized to canonical; sandbox preserved.
      expect(persistedManifest().iframe.src).toBe('https://hello.civit.ai/');
      expect(persistedManifest().iframe.sandbox).toBe('allow-scripts');
    }
  });

  it('leaves an already-canonical iframe.src unchanged', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({
      iframe: { src: 'https://hello.civit.ai/', minHeight: 300 },
    });
    const result = await submitVersion({ bundleBuffer: buf, submittedByUserId: 42 });
    expect(result.publishRequestId).toBeDefined();
    expect(persistedManifest().iframe.src).toBe('https://hello.civit.ai/');
  });

  it('rejects same-user resubmit with a self-withdrawable error wording', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      id: 'pubreq_existing',
      submittedByUserId: 42,
    });
    const buf = await makeValidBundle();
    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(
      /you already have a pending submission for slug .* \(pubreq_existing\); withdraw it first with `civitai app withdraw pubreq_existing` before resubmitting/
    );
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('rejects other-user collision without leaking the existing request id', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      id: 'pubreq_existing',
      submittedByUserId: 1,
    });
    const buf = await makeValidBundle();
    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/from another user/);
    // The conflicting id is useless to a non-owner — verify the error
    // wording doesn't leak it.
    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.not.toThrow(/pubreq_existing/);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  // C-4 fix verification: the race window between the app-layer "no pending
  // request" check and the INSERT is now closed by a partial unique index
  // (migration 20260528210000_w1_uniqueness_constraints):
  //   CREATE UNIQUE INDEX ... ON app_block_publish_requests (slug)
  //     WHERE status='pending'
  // Two parallel submitVersion calls that both pass the app-layer findFirst
  // (because neither's INSERT is visible to the other yet) collide at the
  // DB. The catch translates the raw P2002 into a human-readable error.
  it('FIX (C-4): second concurrent same-slug submission collides on the partial unique index', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null); // both see no pending
    const buf = await makeValidBundle();

    // First submission lands cleanly (default mockDbWrite create succeeds).
    const r1 = await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 42,
    });
    expect(r1.publishRequestId).toBeDefined();

    // Race window: the second findFirst still sees no pending row because
    // the first INSERT hasn't been visible across replicas yet. The second
    // INSERT trips the partial unique index → P2002.
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    mockDbWrite.appBlockPublishRequest.create.mockRejectedValueOnce(p2002);

    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 43,
      })
    ).rejects.toThrow(/already has a pending publish request/);

    // Both attempted to INSERT; only one succeeded (the race-loser caught
    // P2002 + surfaced the user-readable error).
    expect(mockDbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(2);
  });

  // Verify non-P2002 errors aren't silently swallowed by the C-4 catch.
  it('FIX (C-4): non-P2002 errors on publish_request INSERT are surfaced', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const buf = await makeValidBundle();
    mockDbWrite.appBlockPublishRequest.create.mockRejectedValueOnce(
      new Error('connection reset by peer')
    );

    await expect(
      submitVersion({
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/connection reset/);
  });

  it('Discord notify is invoked with the right shape on submission', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 } as Response));
    vi.stubGlobal('fetch', fetchSpy);

    const buf = await makeValidBundle();
    await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 42,
    });

    // fire-and-forget notify — poll until it lands instead of hand-timing the
    // microtask queue (a new `await` before the fetch would silently make a
    // single-tick wait flaky).
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://discord.example/hook');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.embeds[0].title).toMatch(/New publish request: hello v0\.1\.0/);
    expect(body.embeds[0].url).toBe('https://example.test/apps/review');
  });

  it('Discord notify failure does not block submission', async () => {
    const { submitVersion } = await import('../publish-request.service');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('discord down');
      })
    );
    const buf = await makeValidBundle();
    const result = await submitVersion({
      bundleBuffer: buf,
      submittedByUserId: 42,
    });
    expect(result.publishRequestId).toMatch(/^pubreq_/);
  });
});

// ---- withdrawRequest -------------------------------------------------------

describe('withdrawRequest', () => {
  it('moves pending → withdrawn for the owner via a status-guarded updateMany', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 42,
    });
    // Guarded write matched the still-pending row.
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    await withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 });
    // S1 fix: the write is keyed on { id, status: 'pending' }, NOT id alone, so
    // a concurrent approve that flipped status can't be clobbered.
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'pubreq_x', status: 'pending' },
      data: { status: 'withdrawn' },
    });
    // The unconditional single-row update path must be gone.
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('is idempotent on already-withdrawn (no write at all)', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'withdrawn',
      submittedByUserId: 42,
    });
    await withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 });
    expect(mockDbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('🔴 Fix #1 (onsite): withdrawing a reset (pending onsite listing) closes it REMOVED + a DELIST event (owner canNOT republish)', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_reset',
      status: 'pending',
      submittedByUserId: 42,
      slug: 'my-app',
    });
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    // beforeEach's mockReset strips the tx impl — re-wire it to run the callback.
    mockDbWrite.$transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDbWrite)
    );
    // The reset target: an onsite listing for this slug is currently `pending`. A pending
    // onsite listing is ALWAYS a mod reset (deterministic — NO most-recent-event probe,
    // which an intervening report event could defeat), so the close writes `delist`.
    mockDbRead.appListing.findFirst.mockResolvedValue({ id: 'apl_1', slug: 'my-app' });
    mockDbWrite.appListing.updateMany.mockResolvedValue({ count: 1 });

    await withdrawRequest({ publishRequestId: 'pubreq_reset', userId: 42 });

    // The request is withdrawn AND the reset listing is closed to `removed`.
    expect(mockDbWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', kind: 'onsite', status: 'pending' },
      data: { status: 'removed' },
    });
    // 🔴 A `delist` event (owner as actor) → republishOwnListing's guard FORBIDS the
    // owner; a mod must relist (which also un-suspends the block).
    const evtArg = mockDbWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(evtArg).toMatchObject({
      appListingId: 'apl_1',
      action: 'delist',
      actorUserId: 42,
      before: { status: 'pending' },
      after: { status: 'removed' },
    });
  });

  it('Fix #1 (onsite): a FIRST-TIME submission withdraw (no reset listing) does NOT close any listing', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_first',
      status: 'pending',
      submittedByUserId: 42,
      slug: 'brand-new',
    });
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    // No approved listing yet for a never-approved app → the reset probe finds nothing.
    mockDbRead.appListing.findFirst.mockResolvedValue(null);

    await withdrawRequest({ publishRequestId: 'pubreq_first', userId: 42 });

    expect(mockDbWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('throws NOT_OWNED for a request owned by a different user', async () => {
    const { withdrawRequest, WithdrawRequestError } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 1,
    });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toMatchObject({
      code: 'NOT_OWNED',
      message: expect.stringMatching(/can only withdraw your own/),
    });
    // No write is attempted on a not-owned row.
    expect(mockDbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
    // The thrown value is the typed class.
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toBeInstanceOf(WithdrawRequestError);
  });

  it('throws NOT_PENDING for already-approved', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'approved',
      submittedByUserId: 42,
    });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toMatchObject({
      code: 'NOT_PENDING',
      message: expect.stringMatching(/cannot withdraw a request in status approved/),
    });
    expect(mockDbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('throws NOT_PENDING for already-rejected', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'rejected',
      submittedByUserId: 42,
    });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toMatchObject({
      code: 'NOT_PENDING',
      message: expect.stringMatching(/cannot withdraw a request in status rejected/),
    });
  });

  it('throws NOT_FOUND when the request is not found', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/not found/) });
    expect(mockDbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  // S1 (TOCTOU) — findUnique classified `pending`, but the guarded updateMany
  // matched 0 rows because a concurrent approveRequest flipped status between
  // the read and the write. A re-read showing `approved` MUST surface as
  // NOT_PENDING (the row is NOT clobbered approved→withdrawn).
  it('S1: lost the race to a concurrent approve → updateMany count:0, primary re-read approved → NOT_PENDING', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    // Classify read (replica): still pending. Re-read (PRIMARY): approved.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 42,
    });
    mockDbWrite.appBlockPublishRequest.findUnique.mockResolvedValue({ status: 'approved' });
    // Guarded write matched 0 rows (the row is no longer pending).
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toMatchObject({
      code: 'NOT_PENDING',
      message: expect.stringMatching(/cannot withdraw a request in status approved/),
    });
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'pubreq_x', status: 'pending' },
      data: { status: 'withdrawn' },
    });
    // The race is resolved against the PRIMARY, not the (lag-prone) replica.
    expect(mockDbWrite.appBlockPublishRequest.findUnique).toHaveBeenCalledWith({
      where: { id: 'pubreq_x' },
      select: { status: true },
    });
  });

  // S1 idempotency under the race — if the row raced into `withdrawn` (a
  // concurrent withdraw won), count:0 + a re-read of `withdrawn` resolves as
  // idempotent SUCCESS, no throw.
  it('S1: lost the race to a concurrent withdraw → updateMany count:0, primary re-read withdrawn → idempotent success', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 42,
    });
    mockDbWrite.appBlockPublishRequest.findUnique.mockResolvedValue({ status: 'withdrawn' });
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).resolves.toBeUndefined();
  });

  // H-2 regression — withdraw does NOT delete the S3 bundle. Long-tail
  // storage growth; flip this test when a GC job lands.
  it('REGRESSION (H-2): does not touch S3 on withdraw', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 42,
    });
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
    await withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 });
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

// ---- getMyPendingForSlug ---------------------------------------------------

describe('getMyPendingForSlug', () => {
  it('returns null when no pending request exists for the slug', async () => {
    const { getMyPendingForSlug } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const result = await getMyPendingForSlug({ slug: 'hello-world', userId: 42 });
    expect(result).toBeNull();
    expect(mockDbRead.appBlockPublishRequest.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hello-world', status: 'pending', submittedByUserId: 42 },
      select: { id: true, version: true, submittedAt: true },
    });
  });

  it("returns the caller's own pending row when one exists", async () => {
    const { getMyPendingForSlug } = await import('../publish-request.service');
    const submittedAt = new Date('2026-05-29T13:48:00Z');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      id: 'pubreq_mine',
      version: '0.1.0',
      submittedAt,
    });
    const result = await getMyPendingForSlug({ slug: 'hello-world', userId: 42 });
    expect(result).toEqual({
      id: 'pubreq_mine',
      version: '0.1.0',
      submittedAt,
    });
  });

  it("does not surface another user's pending request (scoped via where clause)", async () => {
    // The where clause filters by submittedByUserId, so the test must
    // assert the query shape — mocking findFirst can't distinguish
    // "owned by 42" from "owned by 1" by itself. This test guards
    // against accidentally widening the scope.
    const { getMyPendingForSlug } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    await getMyPendingForSlug({ slug: 'hello-world', userId: 42 });
    // mockDbRead surfaces are typed as bare vi.fn() with no signature, so
    // their .calls tuple is `[]`. Reach through `unknown` to inspect the
    // captured args (same pattern other tests use for the Discord fetch
    // spy).
    const calls = (
      mockDbRead.appBlockPublishRequest.findFirst as unknown as {
        mock: { calls: Array<[{ where: Record<string, unknown> }]> };
      }
    ).mock.calls;
    expect(calls[0]?.[0]?.where).toMatchObject({
      slug: 'hello-world',
      status: 'pending',
      submittedByUserId: 42,
    });
  });
});

// ---- listPendingRequests ---------------------------------------------------

describe('listPendingRequests', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'pubreq_1',
      appBlockId: null,
      submittedAt: new Date('2026-05-28T12:00:00Z'),
      bundleSizeBytes: 12345n,
      bundleSha256: 'abc',
      manifest: {},
      fileSummary: {},
      manifestDiffSummary: {},
      submittedBy: { id: 1, username: 'dev', image: null },
      ...over,
    };
  }

  it('returns oldest-first (FIFO) without cursor', async () => {
    const { listPendingRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ id: 'pubreq_1', submittedAt: new Date('2026-05-28T11:00:00Z') }),
      row({ id: 'pubreq_2', submittedAt: new Date('2026-05-28T12:00:00Z') }),
    ]);
    const result = await listPendingRequests({});
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_1', 'pubreq_2']);
    expect(result.nextCursor).toBeNull();
    // findMany should have been called with orderBy submittedAt asc.
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ submittedAt: 'asc' });
    expect(arg.where).toEqual({ status: 'pending' });
  });

  it('paginates using cursor', async () => {
    const { listPendingRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([row({ id: 'pubreq_3' })]);
    await listPendingRequests({ cursor: 'pubreq_2', limit: 1 });
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 'pubreq_2' });
    expect(arg.skip).toBe(1);
    expect(arg.take).toBe(2); // limit + 1
  });

  it('signals more pages when result is exactly limit+1', async () => {
    const { listPendingRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ id: 'pubreq_1' }),
      row({ id: 'pubreq_2' }),
      row({ id: 'pubreq_3' }), // third row is the "has next" indicator
    ]);
    const result = await listPendingRequests({ limit: 2 });
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_1', 'pubreq_2']);
    expect(result.nextCursor).toBe('pubreq_2');
  });

  it('converts BigInt bundleSizeBytes → string for JSON serialisation', async () => {
    const { listPendingRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ bundleSizeBytes: 1234567890n }),
    ]);
    const result = await listPendingRequests({});
    expect(result.items[0].bundleSizeBytes).toBe('1234567890');
    expect(typeof result.items[0].bundleSizeBytes).toBe('string');
  });

  it('caps limit to 100 even when caller asks for more', async () => {
    const { listPendingRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    await listPendingRequests({ limit: 1000 });
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.take).toBe(101); // 100 cap + 1
  });
});

// ---- listApprovedRequests --------------------------------------------------

describe('listApprovedRequests', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'pubreq_1',
      appBlockId: 'apb_1',
      slug: 'hello',
      version: '0.1.0',
      submittedAt: new Date('2026-05-27T10:00:00Z'),
      reviewedAt: new Date('2026-05-28T12:00:00Z'),
      approvalNotes: 'lgtm',
      bundleSizeBytes: 12345n,
      bundleSha256: 'abc',
      manifest: {},
      fileSummary: {},
      manifestDiffSummary: {},
      submittedBy: { id: 1, username: 'dev', image: null },
      reviewedBy: { id: 999, username: 'mod', image: null },
      ...over,
    };
  }

  it('returns empty list with nextCursor=null when there are no approved requests', async () => {
    const { listApprovedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const result = await listApprovedRequests({});
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by status=approved and orders by reviewedAt desc', async () => {
    const { listApprovedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ id: 'pubreq_a', reviewedAt: new Date('2026-05-28T15:00:00Z') }),
      row({ id: 'pubreq_b', reviewedAt: new Date('2026-05-28T10:00:00Z') }),
    ]);
    const result = await listApprovedRequests({});
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_a', 'pubreq_b']);
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ reviewedAt: 'desc' });
    expect(arg.where).toEqual({ status: 'approved' });
  });

  it('surfaces approvalNotes + reviewedBy on each item', async () => {
    const { listApprovedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({
        approvalNotes: 'reviewed the iframe sandbox flags, looks good',
        reviewedBy: { id: 999, username: 'modzilla', image: null },
      }),
    ]);
    const result = await listApprovedRequests({});
    expect(result.items[0].approvalNotes).toBe('reviewed the iframe sandbox flags, looks good');
    expect(result.items[0].reviewedBy).toEqual({ id: 999, username: 'modzilla', image: null });
  });

  it('paginates with cursor — uses cursor + skip:1 + take=limit+1', async () => {
    const { listApprovedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([row({ id: 'pubreq_z' })]);
    await listApprovedRequests({ cursor: 'pubreq_y', limit: 1 });
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 'pubreq_y' });
    expect(arg.skip).toBe(1);
    expect(arg.take).toBe(2);
  });

  it('signals more pages when result is exactly limit+1', async () => {
    const { listApprovedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ id: 'pubreq_1' }),
      row({ id: 'pubreq_2' }),
      row({ id: 'pubreq_3' }), // limit+1 — the trailing "has next" indicator
    ]);
    const result = await listApprovedRequests({ limit: 2 });
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_1', 'pubreq_2']);
    expect(result.nextCursor).toBe('pubreq_2');
  });

  it('attaches reviewRepoUrl per row so the read-only modal can link to Forgejo', async () => {
    const { listApprovedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([row({ slug: 'hello-world' })]);
    const result = await listApprovedRequests({});
    expect(result.items[0].reviewRepoUrl).toBe(
      'https://forgejo.example/civitai-apps-review/hello-world'
    );
  });
});

// ---- listRejectedRequests --------------------------------------------------

describe('listRejectedRequests', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'pubreq_1',
      appBlockId: null,
      slug: 'spammy',
      version: '0.1.0',
      submittedAt: new Date('2026-05-27T10:00:00Z'),
      reviewedAt: new Date('2026-05-28T12:00:00Z'),
      rejectionReason: 'manifest contentRating mismatch — please file as adult content',
      bundleSizeBytes: 12345n,
      bundleSha256: 'abc',
      manifest: {},
      fileSummary: {},
      manifestDiffSummary: {},
      submittedBy: { id: 1, username: 'dev', image: null },
      reviewedBy: { id: 999, username: 'mod', image: null },
      ...over,
    };
  }

  it('returns empty list with nextCursor=null when there are no rejected requests', async () => {
    const { listRejectedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([]);
    const result = await listRejectedRequests({});
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by status=rejected and orders by reviewedAt desc', async () => {
    const { listRejectedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ id: 'pubreq_a', reviewedAt: new Date('2026-05-28T15:00:00Z') }),
      row({ id: 'pubreq_b', reviewedAt: new Date('2026-05-28T10:00:00Z') }),
    ]);
    const result = await listRejectedRequests({});
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_a', 'pubreq_b']);
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ reviewedAt: 'desc' });
    expect(arg.where).toEqual({ status: 'rejected' });
  });

  it('surfaces rejectionReason + reviewedBy on each item', async () => {
    const { listRejectedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({
        rejectionReason: 'iframe.src origin must match the OauthClient allowedOrigin',
        reviewedBy: { id: 999, username: 'modzilla', image: null },
      }),
    ]);
    const result = await listRejectedRequests({});
    expect(result.items[0].rejectionReason).toBe(
      'iframe.src origin must match the OauthClient allowedOrigin'
    );
    expect(result.items[0].reviewedBy).toEqual({ id: 999, username: 'modzilla', image: null });
  });

  it('paginates with cursor — uses cursor + skip:1 + take=limit+1', async () => {
    const { listRejectedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([row({ id: 'pubreq_z' })]);
    await listRejectedRequests({ cursor: 'pubreq_y', limit: 1 });
    const arg = mockDbRead.appBlockPublishRequest.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 'pubreq_y' });
    expect(arg.skip).toBe(1);
    expect(arg.take).toBe(2);
  });

  it('signals more pages when result is exactly limit+1', async () => {
    const { listRejectedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      row({ id: 'pubreq_1' }),
      row({ id: 'pubreq_2' }),
      row({ id: 'pubreq_3' }), // trailing has-next indicator
    ]);
    const result = await listRejectedRequests({ limit: 2 });
    expect(result.items.map((r: { id: string }) => r.id)).toEqual(['pubreq_1', 'pubreq_2']);
    expect(result.nextCursor).toBe('pubreq_2');
  });

  it('attaches reviewRepoUrl per row so the read-only modal can link to Forgejo', async () => {
    const { listRejectedRequests } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findMany.mockResolvedValue([row({ slug: 'spammy' })]);
    const result = await listRejectedRequests({});
    expect(result.items[0].reviewRepoUrl).toBe(
      'https://forgejo.example/civitai-apps-review/spammy'
    );
  });
});

// ---- approveRequest --------------------------------------------------------

describe('approveRequest', () => {
  function pendingRequest(over: Record<string, unknown> = {}) {
    return {
      id: 'pubreq_1',
      status: 'pending',
      slug: 'hello',
      version: '0.1.0',
      manifest: manifest(),
      bundleKey: 'bundles/sha.zip',
      submittedByUserId: 42,
      appBlockId: null,
      ...over,
    };
  }

  beforeEach(() => {
    // Defaults for the bundle the approver fetches from S3.
    mockBundleBuffer.current = null; // tests set this
    mockForgejo.createRepoFromTemplate.mockResolvedValue({
      id: 1,
      name: 'hello',
      full_name: 'civitai-apps/hello',
      html_url: 'https://forgejo.example/civitai-apps/hello',
      clone_url: 'https://forgejo.example/civitai-apps/hello.git',
      ssh_url: 'git@forgejo.example:civitai-apps/hello.git',
      default_branch: 'main',
    });
    mockForgejo.ensurePushWebhook.mockResolvedValue(undefined);
    mockForgejo.commitFiles.mockResolvedValue({ sha: 'commit_sha_abc' });
  });

  it('first-version happy path wires the 4 external systems in order', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockBundleBuffer.current = await makeValidBundle();

    const result = await approveRequest({
      publishRequestId: 'pubreq_1',
      reviewerUserId: 999,
      approvalNotes: 'lgtm',
    });

    expect(result.isFirstVersion).toBe(true);
    expect(result.forgejoCommitSha).toBe('commit_sha_abc');

    // Order of operations checks
    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledOnce();
    expect(mockForgejo.createRepoFromTemplate).toHaveBeenCalledOnce();
    expect(mockForgejo.ensurePushWebhook).toHaveBeenCalledOnce();
    expect(mockDbWrite.appBlock.create).toHaveBeenCalledOnce();
    expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
    expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledOnce();

    // no-trust-on-push: the FIRST DEPLOY is unaffected, but the build is now
    // triggered by approveRequest itself (the git-push webhook no longer
    // triggers builds). The committed sha is stamped onto current_version_sha
    // (the webhook's approval marker) and the Tekton build is kicked.
    // F-E E5: step-6 also persists the validated screenshot set. This bundle
    // has no `screenshots/` dir, so the gallery is the empty array (a re-approve
    // that removed screenshots would clear the column the same way).
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentVersionSha: 'commit_sha_abc', screenshots: [] } })
    );
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    expect(mockTriggerBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'hello', sha: 'commit_sha_abc' })
    );
    // Any stray pending review request the webhook may have parked for the slug
    // while racing this approve is superseded (withdrawn).
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slug: 'hello', status: 'pending' }),
        data: { status: 'withdrawn' },
      })
    );

    // Phase 2: after triggerBuild succeeds, the approved request is marked
    // 'building' so the developer sees the lifecycle on /apps/my-submissions.
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'hello', forgejoCommitSha: 'commit_sha_abc', status: 'approved' },
        data: expect.objectContaining({ deployState: 'building' }),
      })
    );

    // OauthClient gets the slug-scoped allowedOrigins + a deterministic id
    // (post C-2 fix). The deterministic id is what makes retries idempotent.
    const ocArg = mockDbWrite.oauthClient.create.mock.calls[0][0].data;
    expect(ocArg.id).toBe('appblk-hello');
    expect(ocArg.allowedOrigins).toEqual(['https://hello.civit.ai']);
    expect(ocArg.userId).toBe(42);
    expect(ocArg.isConfidential).toBe(false);

    // A1 fix: app-block client is structurally non-interactive. grants:[]
    // removes the Prisma default ["authorization_code","refresh_token"] so it
    // can never drive the OAuth code/device flow that mints account tokens.
    // allowedScopes is the manifest-derived ceiling — for the default
    // zero-scope manifest that's 0, NOT TokenScope.Full (33554431).
    expect(ocArg.grants).toEqual([]);
    expect(ocArg.allowedScopes).toBe(0);

    // commitFiles received the bundle contents with replaceAllFiles=true.
    const commitArg = mockForgejo.commitFiles.mock.calls[0][0];
    expect(commitArg.slug).toBe('hello');
    expect(commitArg.replaceAllFiles).toBe(true);
    // A8/BUILD-1 Phase 2: the platform-owned Dockerfile (and nginx.conf) are
    // NOT committed to the canonical build-source repo — the pipeline injects
    // its own recipe + ignores tenant copies. makeValidBundle ships a
    // Dockerfile; it is dropped from the commit.
    expect(commitArg.files.map((f: { path: string }) => f.path).sort()).toEqual([
      'block.manifest.json',
      'index.html',
    ]);

    // iframe.src is platform-owned: the committed block.manifest.json carries
    // the canonical per-app subdomain root (the default test manifest ships
    // `https://hello.civit.ai` with no trailing slash → normalized to `.../`),
    // so civitai-apps/<slug> stays byte-consistent with app_blocks.manifest and
    // the git-push webhook re-validates the canonical value.
    const committedManifest = JSON.parse(
      commitArg.files
        .find((f: { path: string }) => f.path === 'block.manifest.json')
        .content.toString('utf8')
    );
    expect(committedManifest.iframe.src).toBe('https://hello.civit.ai/');
    // ...and the app_blocks row stores the same canonical value.
    const abArg = mockDbWrite.appBlock.create.mock.calls[0][0].data;
    expect((abArg.manifest as any).iframe.src).toBe('https://hello.civit.ai/');
  });

  it('🔴 W13 onsite reset re-approve (SUBSEQUENT-version): restores the listing AND UN-SUSPENDS the block', async () => {
    // The real reset scenario: the block ALREADY exists (isFirstVersion=false), so the
    // approve takes the subsequent-version `appBlock.update` branch — which refreshes
    // manifest/version but does NOT set status. `resetOnsiteListingToPending` left the
    // block `suspended`, so the re-approve must un-suspend it explicitly, else the app
    // is store-visible (listing approved) but dead (block suspended, run page 404s).
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      repoUrl: 'https://forgejo.example/civitai-apps/hello',
      app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
    });
    mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0' });
    // The reset listing flip matches one row (listing WAS pending) → reset re-approve.
    mockDbWrite.appListing.updateMany.mockResolvedValue({ count: 1 });

    const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });
    expect(result.isFirstVersion).toBe(false);

    // (a) listing restored pending → approved (guarded to `pending`; status-only).
    expect(mockDbWrite.appListing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ appBlockId: 'apb_existing', kind: 'onsite', status: 'pending' }),
        data: { status: 'approved' },
      })
    );
    // 🔴 (b) block un-suspended suspended → approved (guarded to `suspended`) — the fix
    // for the "store-visible but dead" bug. Gated on the listing flip having matched.
    expect(mockDbWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: 'apb_existing', status: 'suspended' },
      data: { status: 'approved' },
    });
  });

  it('normal subsequent-version approve (listing NOT pending) does NOT un-suspend the block', async () => {
    // Guard the gate: when the listing flip matches 0 rows (a normal approve of an
    // already-approved app, NOT a reset), the block un-suspend must NOT fire — so a
    // delisted-then-resubmitted app is never auto-un-suspended here.
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      repoUrl: 'https://forgejo.example/civitai-apps/hello',
      app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
    });
    mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0' });
    // Listing flip matches 0 rows (not a reset) → the block un-suspend is skipped.
    mockDbWrite.appListing.updateMany.mockResolvedValue({ count: 0 });

    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

    const unsuspend = mockDbWrite.appBlock.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'approved' && c[0]?.where?.status === 'suspended'
    );
    expect(unsuspend).toBeUndefined();
  });

  // PUSH-ORIGINATED approve (Phase 3 git-push authoring). The git-push webhook
  // parks an unreviewed direct push as a `pending` request with EMPTY bundle
  // pointers (bundleKey='', bundleSha256='') + the pushed forgejoCommitSha — the
  // ZIP was never uploaded, so the Forgejo repo at that sha IS the artifact.
  // approveRequest must reconstruct the bundle from Forgejo (NOT GET a bundleKey
  // from S3), then drive the identical downstream: commit, sha stamp, build
  // trigger, deployState='building'.
  it('PUSH path: reconstructs the bundle from Forgejo when bundleKey is empty', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({
        bundleKey: '',
        bundleSha256: '',
        forgejoCommitSha: 'pushsha123',
      })
    );
    // First version (no existing app block) — exercises the full create path.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    // The repo @ pushsha123 has a manifest + index.html (no Dockerfile this
    // time, so nothing is filtered as platform-owned).
    mockForgejo.listRepoTreeAtRef.mockResolvedValue(
      new Map([
        ['block.manifest.json', 'blobM'],
        ['index.html', 'blobH'],
      ])
    );
    mockForgejo.getBlobContent.mockImplementation(async (_slug: string, sha: string) => {
      if (sha === 'blobM') return Buffer.from(JSON.stringify(manifest()));
      return Buffer.from('<!doctype html><html><body>pushed</body></html>');
    });
    // mockBundleBuffer.current stays null — if the code ever fell back to the S3
    // GET path the mock S3 GET throws ("mockBundleBuffer.current not set"),
    // which would fail this test. That's the regression guard.

    const result = await approveRequest({
      publishRequestId: 'pubreq_1',
      reviewerUserId: 999,
      approvalNotes: 'reviewed the pushed code',
    });

    // Reconstructed from Forgejo at the EXACT pushed sha.
    expect(mockForgejo.listRepoTreeAtRef).toHaveBeenCalledWith('hello', 'pushsha123');
    // NO S3 GET on a bundleKey (the push request has none). storeScreenshots /
    // storeBundle PUTs are fine; assert specifically no GetObjectCommand fired.
    const gets = mockS3Send.mock.calls.filter(
      (c) => c[0]?.constructor?.name === 'GetObjectCommand'
    );
    expect(gets).toHaveLength(0);

    expect(result.isFirstVersion).toBe(true);
    expect(result.forgejoCommitSha).toBe('commit_sha_abc');

    // Committed the reconstructed files (manifest gets the canonical iframe.src
    // rewrite; index.html passes through).
    const commitArg = mockForgejo.commitFiles.mock.calls[0][0];
    expect(commitArg.replaceAllFiles).toBe(true);
    expect(commitArg.files.map((f: { path: string }) => f.path).sort()).toEqual([
      'block.manifest.json',
      'index.html',
    ]);

    // current_version_sha stamped to the new committed sha.
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentVersionSha: 'commit_sha_abc', screenshots: [] } })
    );
    // Build triggered with the committed sha.
    expect(mockTriggerBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'hello', sha: 'commit_sha_abc' })
    );
    // Phase 2: marked 'building' after the trigger succeeds.
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'hello', forgejoCommitSha: 'commit_sha_abc', status: 'approved' },
        data: expect.objectContaining({ deployState: 'building' }),
      })
    );
    // The publish_request is finalised approved.
    const reqUpdate = mockDbWrite.appBlockPublishRequest.update.mock.calls.find(
      (c: any[]) => c[0]?.where?.id === 'pubreq_1'
    );
    expect(reqUpdate?.[0]?.data?.status).toBe('approved');
  });

  // ZIP-path regression: a request WITH a bundleKey still GETs from S3 and never
  // touches the Forgejo-reconstruct path.
  it('ZIP path: still GETs the bundle from S3 (no Forgejo reconstruct) when bundleKey is set', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({ bundleKey: 'bundles/sha.zip' })
    );
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockBundleBuffer.current = await makeValidBundle();

    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

    // S3 GET happened on the bundleKey path.
    const gets = mockS3Send.mock.calls.filter(
      (c) => c[0]?.constructor?.name === 'GetObjectCommand'
    );
    expect(gets).toHaveLength(1);
    // Forgejo reconstruct path was NOT taken.
    expect(mockForgejo.listRepoTreeAtRef).not.toHaveBeenCalled();
  });

  // Defensive: a malformed request with neither a bundle nor a sha throws clearly.
  it('throws clearly when a request has neither a bundle nor a forgejo commit', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({ bundleKey: '', bundleSha256: '', forgejoCommitSha: '' })
    );
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/neither a bundle nor a forgejo commit/);
  });

  it('A1: caps OauthClient.allowedScopes to the manifest-derived bitmask (not Full)', async () => {
    const { approveRequest } = await import('../publish-request.service');
    // models:read:self (bit 1<<2 = 4) + user:read:self (1<<0 = 1) +
    // apps:storage:write (SKIP_OAUTH_CHECK → contributes 0). Derived OAuth
    // ceiling must be 4|1 = 5, never 33554431 (Full). approveRequest reads the
    // scopes from request.manifest (the publish_request row), not the bundle.
    const scopedManifest = manifest({
      scopes: ['models:read:self', 'user:read:self', 'apps:storage:write'],
    });
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({ manifest: scopedManifest })
    );
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockBundleBuffer.current = await makeValidBundle({
      scopes: ['models:read:self', 'user:read:self', 'apps:storage:write'],
    });

    await approveRequest({
      publishRequestId: 'pubreq_1',
      reviewerUserId: 999,
      approvalNotes: 'lgtm',
    });

    const ocArg = mockDbWrite.oauthClient.create.mock.calls[0][0].data;
    expect(ocArg.allowedScopes).toBe(5);
    expect(ocArg.allowedScopes).not.toBe(33554431);
    expect(ocArg.grants).toEqual([]);
  });

  it('subsequent-version happy path skips OauthClient + repo create', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      repoUrl: 'https://forgejo.example/civitai-apps/hello',
      // H-4 fix path: approveRequest's pre-validation reads the
      // existing OauthClient context off this relation.
      app: {
        allowedScopes: 33554431,
        allowedOrigins: ['https://hello.civit.ai'],
      },
    });
    mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0' });

    const result = await approveRequest({
      publishRequestId: 'pubreq_1',
      reviewerUserId: 999,
    });

    expect(result.isFirstVersion).toBe(false);
    expect(result.appBlockId).toBe('apb_existing');

    expect(mockDbWrite.oauthClient.create).not.toHaveBeenCalled();
    expect(mockForgejo.createRepoFromTemplate).not.toHaveBeenCalled();
    expect(mockForgejo.ensurePushWebhook).not.toHaveBeenCalled();
    // Two appBlock.update calls now: (1) refresh manifest/version/scopes, then
    // (2) stamp current_version_sha = the committed sha (no-trust-on-push: this
    // is the moderator-approval marker the git-push webhook keys its gate off).
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledTimes(2);
    const shaStamp = mockDbWrite.appBlock.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.currentVersionSha !== undefined
    );
    expect(shaStamp?.[0]).toMatchObject({
      where: { id: 'apb_existing' },
      data: { currentVersionSha: 'commit_sha_abc' },
    });
    expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
    // approveRequest now triggers the Tekton build itself (the webhook no
    // longer does) with the committed sha + the existing app block id.
    expect(mockTriggerBuild).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'hello', sha: 'commit_sha_abc', appBlockId: 'apb_existing' })
    );

    // A1 fix: the existing OauthClient's ceiling is re-capped to the derived
    // bitmask + forced to grants:[] on every subsequent approve — self-heals
    // a row that was created as Full (33554431) + interactive grants before
    // this fix. Default manifest has no scopes → ceiling 0.
    expect(mockDbWrite.oauthClient.update).toHaveBeenCalledOnce();
    const ocUpdateArg = mockDbWrite.oauthClient.update.mock.calls[0][0];
    expect(ocUpdateArg.where).toEqual({ id: 'oc_existing' });
    expect(ocUpdateArg.data.grants).toEqual([]);
    expect(ocUpdateArg.data.allowedScopes).toBe(0);
  });

  // ---- C1: trust-tier self-escalation (the most security-critical contract) ----
  //
  // The fix at publish-request.service.ts:1050-1062: trust tier is
  // moderator-controlled, NEVER publisher-declared. `internal`/`verified`
  // grant `allow-same-origin`, which defeats the iframe sandbox. A manifest
  // that declares a raised trustTier must be IGNORED:
  //   - new app  → always persisted as `unverified`
  //   - existing → keeps whatever tier is on the DB row
  // and the normalised manifest (which the sandbox-allowlist validator reads)
  // must carry the resolved tier too, so the validator can't be tricked.
  describe('C1: trust-tier is resolved from DB, never raised by the manifest', () => {
    it('NEW app: a manifest declaring trustTier:internal is persisted as unverified', async () => {
      const { approveRequest } = await import('../publish-request.service');
      const evilManifest = manifest({ trustTier: 'internal' });
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: evilManifest })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ trustTier: 'internal' });

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      const createArg = mockDbWrite.appBlock.create.mock.calls[0][0].data;
      // The column the live host reads to decide the sandbox allowlist.
      expect(createArg.trustTier).toBe('unverified');
      expect(createArg.trustTier).not.toBe('internal');
      // The normalised manifest persisted on the row must ALSO be downgraded,
      // so a later reader keying off manifest.trustTier can't be escalated.
      expect((createArg.manifest as { trustTier?: string }).trustTier).toBe('unverified');
    });

    it('NEW app: a manifest declaring trustTier:verified is persisted as unverified', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ trustTier: 'verified' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ trustTier: 'verified' });

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      const createArg = mockDbWrite.appBlock.create.mock.calls[0][0].data;
      expect(createArg.trustTier).toBe('unverified');
      expect((createArg.manifest as { trustTier?: string }).trustTier).toBe('unverified');
    });

    it('NEW app: a manifest with NO trustTier field still resolves to unverified (no default-to-internal regression)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      // The pre-fix bug DEFAULTED a missing manifest.trustTier to `internal`.
      const noTierManifest = manifest();
      delete (noTierManifest as Record<string, unknown>).trustTier;
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: noTierManifest })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      const createArg = mockDbWrite.appBlock.create.mock.calls[0][0].data;
      expect(createArg.trustTier).toBe('unverified');
    });

    it('EXISTING app: keeps the DB trust tier even when the new manifest declares internal', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ version: '0.2.0', trustTier: 'internal' }) })
      );
      // Existing row is `verified` (a deliberate out-of-band moderator action).
      // The manifest declaring `internal` must NOT change it (neither up nor down).
      mockDbRead.appBlock.findFirst.mockResolvedValue({
        id: 'apb_existing',
        appId: 'oc_existing',
        repoUrl: 'https://forgejo.example/civitai-apps/hello',
        trustTier: 'verified',
        app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
      });
      mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0', trustTier: 'internal' });

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The manifest-refresh update (NOT the currentVersionSha stamp) carries
      // the trust tier. It must equal the DB tier, not the manifest's claim.
      const tierUpdate = mockDbWrite.appBlock.update.mock.calls.find(
        (c: any[]) => c[0]?.data?.trustTier !== undefined
      );
      expect(tierUpdate?.[0]?.data?.trustTier).toBe('verified');
      expect((tierUpdate?.[0]?.data?.manifest as { trustTier?: string }).trustTier).toBe('verified');
    });

    it('EXISTING unverified app: a manifest declaring internal stays unverified', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ version: '0.2.0', trustTier: 'internal' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue({
        id: 'apb_existing',
        appId: 'oc_existing',
        repoUrl: 'https://forgejo.example/civitai-apps/hello',
        trustTier: 'unverified',
        app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
      });
      mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0', trustTier: 'internal' });

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      const tierUpdate = mockDbWrite.appBlock.update.mock.calls.find(
        (c: any[]) => c[0]?.data?.trustTier !== undefined
      );
      expect(tierUpdate?.[0]?.data?.trustTier).toBe('unverified');
    });
  });

  // C-2 regression — failure at step 2 (Forgejo repo create) leaves the
  // OauthClient INSERT in place with no compensation.
  it('REGRESSION (C-2): Forgejo repo create failure leaves orphaned OauthClient', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockForgejo.createRepoFromTemplate.mockRejectedValue(
      new Error('Forgejo 500 Internal Server Error')
    );

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/Forgejo 500/);

    // OauthClient INSERT succeeded; AppBlock + publishRequest update did NOT.
    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledOnce();
    expect(mockDbWrite.appBlock.create).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  // C-2 regression — failure at step 4 (AppBlock INSERT) leaves OC + repo + webhook orphaned.
  it('REGRESSION (C-2): AppBlock INSERT failure leaves orphaned OauthClient + Forgejo repo', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbWrite.appBlock.create.mockRejectedValue(new Error('AppBlock INSERT failed'));

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/AppBlock INSERT failed/);

    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledOnce();
    expect(mockForgejo.createRepoFromTemplate).toHaveBeenCalledOnce();
    expect(mockForgejo.ensurePushWebhook).toHaveBeenCalledOnce();
    expect(mockForgejo.commitFiles).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  // C-2 regression — failure at step 6 (commitFiles) leaves the AppBlock with
  // a Forgejo repo URL but no commit content; webhook never fires.
  it('REGRESSION (C-2): commitFiles failure leaves AppBlock row pointing at empty repo', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockBundleBuffer.current = await makeValidBundle();
    mockForgejo.commitFiles.mockRejectedValue(new Error('Forgejo conflict on commit'));

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/Forgejo conflict/);

    // AppBlock was created BEFORE commitFiles; the publish_request update did NOT happen.
    expect(mockDbWrite.appBlock.create).toHaveBeenCalledOnce();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  // H-3 regression — Forgejo 404 on multi-file commit (the route may not be
  // registered on older Forgejo versions) surfaces as a clean error.
  it('REGRESSION (H-3): Forgejo 404 on commitFiles bubbles up readably', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockBundleBuffer.current = await makeValidBundle();
    mockForgejo.commitFiles.mockRejectedValue(
      new Error('Forgejo 404 Not Found: route not registered')
    );

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/404/);
  });

  it('rejects when the request is not pending', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({ status: 'approved' })
    );
    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/cannot approve a request in status approved/);
    expect(mockDbWrite.oauthClient.create).not.toHaveBeenCalled();
  });

  it('rejects when the request id does not exist', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      approveRequest({ publishRequestId: 'pubreq_missing', reviewerUserId: 999 })
    ).rejects.toThrow(/not found/);
  });

  // C-3 fix verification — two parallel first-version approves for the same
  // slug. Pre-fix, both would create distinct OauthClient + AppBlock rows
  // because the appId was freshly generated each call. Post-fix, the
  // deterministic OauthClient.id (`appblk-<slug>`) means the second create
  // hits a unique constraint (P2002); we catch and fall through to the
  // existing row. Net: one OauthClient + one AppBlock for one slug, even
  // under racing approvers.
  it('FIX (C-3): second concurrent approve dedupes on the deterministic OauthClient id', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null); // both observe no existing
    mockBundleBuffer.current = await makeValidBundle();

    // First approve succeeds end-to-end.
    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

    // Re-arm DB reads for the second approver. appBlock.findFirst is
    // called twice in the first-version path: once for the isFirstVersion
    // check (race-window null), and once inside the appBlock.create
    // P2002-catch (returns the row approver-1 inserted). Order matters —
    // mockResolvedValueOnce queue is consumed in registration order.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst
      .mockResolvedValueOnce(null) // isFirstVersion check: still race-window null
      .mockResolvedValueOnce({ id: 'apb_first' }); // catch recovery: approver-1's row

    // Simulate the unique-constraint violation that Postgres would raise
    // on the second OauthClient.create with the same deterministic id.
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    mockDbWrite.oauthClient.create.mockRejectedValueOnce(p2002);
    // The post-P2002 lookup returns the row from approver-1.
    mockDbRead.oauthClient.findUnique.mockResolvedValueOnce({ id: 'appblk-hello' });
    // AppBlock.create for the second approver also hits the (appId,blockId)
    // unique constraint and falls through to findFirst.
    mockDbWrite.appBlock.create.mockRejectedValueOnce(p2002);

    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 998 });

    // Both creates were ATTEMPTED twice (call count), but only one of each
    // materialized (the second was caught + recovered).
    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.appBlock.create).toHaveBeenCalledTimes(2);
    expect(mockDbRead.oauthClient.findUnique).toHaveBeenCalled();
    // The second approver UPDATEs the existing AppBlock (refreshes manifest)
    // instead of inserting a new one — converges to a consistent state.
    expect(mockDbWrite.appBlock.update).toHaveBeenCalled();
  });

  // C-2 fix verification — retry safety. A failed first attempt followed by
  // a second attempt converges to a single OauthClient + AppBlock, instead
  // of accumulating orphans.
  it('FIX (C-2): retry after Forgejo failure dedupes via deterministic OauthClient id', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockBundleBuffer.current = await makeValidBundle();

    // Attempt 1: OauthClient.create succeeds, then Forgejo blows up.
    mockForgejo.createRepoFromTemplate.mockRejectedValueOnce(new Error('Forgejo 503'));
    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/Forgejo 503/);
    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledTimes(1);

    // Attempt 2: same request, Forgejo now healthy. The second
    // OauthClient.create hits the (deterministic) id again → P2002 →
    // catch → findUnique returns the orphan → continue.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    mockDbWrite.oauthClient.create.mockRejectedValueOnce(p2002);
    mockDbRead.oauthClient.findUnique.mockResolvedValueOnce({ id: 'appblk-hello' });

    const result = await approveRequest({
      publishRequestId: 'pubreq_1',
      reviewerUserId: 999,
    });

    expect(result.isFirstVersion).toBe(true);
    expect(result.forgejoCommitSha).toBe('commit_sha_abc');
    // No orphan accumulation: only one OauthClient materialized despite two
    // calls, and one AppBlock from the second attempt.
    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.appBlock.create).toHaveBeenCalledTimes(1);
    expect(mockForgejo.commitFiles).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledTimes(1);
  });

  // C-3 fix verification — the DB-level UNIQUE on app_blocks(block_id)
  // (migration 20260528210000_w1_uniqueness_constraints) is the
  // belt-and-suspenders layer beneath the C-2 deterministic-id dedup.
  // Models the scenario where the OauthClient layer is somehow bypassed
  // (e.g. legacy data path with a non-deterministic appId) but block_id
  // is still already taken: the AppBlock INSERT trips P2002 and the
  // recovery path falls through to the existing row.
  it('FIX (C-3): AppBlock create with block_id collision falls through to existing row', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    // appBlock.findFirst is called twice in the first-version path: once
    // for isFirstVersion (returns null = first version), then again inside
    // the AppBlock.create P2002 catch (returns the colliding row).
    mockDbRead.appBlock.findFirst
      .mockResolvedValueOnce(null) // isFirstVersion check
      .mockResolvedValueOnce({ id: 'apb_collision' }); // catch recovery
    mockBundleBuffer.current = await makeValidBundle();

    // OauthClient.create succeeds (test isolates the block_id constraint).
    // AppBlock.create trips the new DB constraint on its first try.
    const p2002 = Object.assign(new Error('app_blocks_block_id_unique violation'), {
      code: 'P2002',
    });
    mockDbWrite.appBlock.create.mockRejectedValueOnce(p2002);

    const result = await approveRequest({
      publishRequestId: 'pubreq_1',
      reviewerUserId: 999,
    });

    expect(result.isFirstVersion).toBe(true);
    expect(result.appBlockId).toBe('apb_collision');
    // Two appBlock.update calls: (1) the P2002 recovery path refreshes the
    // existing AppBlock's manifest so the row converges to the new content,
    // then (2) step 6 stamps current_version_sha = the committed sha.
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledTimes(2);
    const shaStamp = mockDbWrite.appBlock.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.currentVersionSha !== undefined
    );
    expect(shaStamp?.[0]).toMatchObject({
      where: { id: 'apb_collision' },
      data: { currentVersionSha: 'commit_sha_abc' },
    });
    expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
    expect(mockTriggerBuild).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'commit_sha_abc', appBlockId: 'apb_collision' })
    );
  });

  // C-2 fix verification — non-P2002 errors are NOT swallowed. If the
  // OauthClient create fails with anything else, we surface the error so
  // ops sees the real failure rather than silently continuing past a bug.
  it('FIX (C-2): non-P2002 errors on OauthClient.create are surfaced', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);

    mockDbWrite.oauthClient.create.mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/connection refused/);
    expect(mockForgejo.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  // H-4 fix — approveRequest now runs the same BlockManifestValidator the
  // git-push webhook runs, BEFORE any DB writes or Forgejo commit. A
  // manifest with a mismatched origin (or other webhook-rejectable shape)
  // is refused at approve time instead of leaving AppBlock.manifest
  // pointing at content the build chain will never accept.
  it('FIX (H-4): subsequent-version approve rejects when manifest fails validation', async () => {
    const { approveRequest } = await import('../publish-request.service');
    // iframe.src is platform-stamped before validation, so it can't be the
    // failure trigger anymore. Use a sandbox token disallowed for the
    // unverified trust tier (the gen-from-model 2026-05-29 incident shape) —
    // a webhook-rejectable manifest that survives canonical-src stamping.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({
        manifest: manifest({
          iframe: { minHeight: 300, sandbox: 'allow-scripts allow-same-origin' },
        }),
      })
    );
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      repoUrl: 'https://forgejo.example/civitai-apps/hello',
      app: {
        allowedScopes: 33554431,
        allowedOrigins: ['https://hello.civit.ai'],
      },
    });

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/Invalid manifest — cannot approve/);

    // Defense in depth: NO writes to any of the four external systems.
    expect(mockDbWrite.appBlock.update).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
    expect(mockForgejo.commitFiles).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // First-version variant: the OauthClient + AppBlock don't exist yet;
  // approveRequest must synthesise the AppContext using the values it
  // WOULD create (per-app subdomain + default allowedScopes) and run the
  // validator against that. Catches the gen-from-model 2026-05-29
  // incident shape (sandbox flag not allowed for trustTier=unverified)
  // before the OauthClient is even created.
  it('FIX (H-4): first-version approve rejects when manifest fails validation', async () => {
    const { approveRequest } = await import('../publish-request.service');
    // iframe.src is platform-stamped before validation; trigger the H-4 refusal
    // via a sandbox token disallowed for the unverified tier instead (a real
    // webhook-rejectable shape that canonical-src stamping does not fix).
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({
        manifest: manifest({
          iframe: { minHeight: 300, sandbox: 'allow-scripts allow-same-origin' },
        }),
      })
    );
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);

    await expect(
      approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
    ).rejects.toThrow(/Invalid manifest — cannot approve/);

    // No OauthClient, no Forgejo repo, no AppBlock row created.
    expect(mockDbWrite.oauthClient.create).not.toHaveBeenCalled();
    expect(mockForgejo.createRepoFromTemplate).not.toHaveBeenCalled();
    expect(mockForgejo.ensurePushWebhook).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlock.create).not.toHaveBeenCalled();
    expect(mockForgejo.commitFiles).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  // ---- W13: onsite AppListing auto-create-on-approve ----------------------
  //
  // approveRequest now mints the store-facing onsite `AppListing` (idempotent,
  // keyed on appBlockId) right after the AppBlock row exists, so an approved app
  // shows on the `/apps` grid without a manual `backfillAppListings` run. It
  // reuses the SAME `mapAppBlockToListing` shape the backfill uses.
  describe('W13: onsite AppListing auto-create', () => {
    it('first-version approve creates the onsite listing with the correct fields', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // Idempotency guard: checked for an existing listing by appBlockId first.
      expect(mockDbRead.appListing.findUnique).toHaveBeenCalledWith({
        where: { appBlockId: result.appBlockId },
        select: { id: true },
      });
      // Exactly one listing minted — onsite, approved, slug=blockId, appBlockId
      // set, name/contentRating derived from the manifest, owner = submitter.
      // A first-version AppBlock has no curation, so category/featured default.
      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);
      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        kind: 'onsite',
        slug: 'hello',
        name: 'Hello World',
        status: 'approved',
        contentRating: 'g',
        appBlockId: result.appBlockId,
        externalUrl: null,
        connectClientId: null,
        userId: 42,
        category: null,
        featured: false,
        featuredOrder: null,
        iconId: null,
        coverId: null,
      });
    });

    it('always mints an ONSITE listing (never offsite — the offsite flow is a separate service)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data.kind).toBe('onsite');
      expect(data.externalUrl).toBeNull();
      expect(data.connectClientId).toBeNull();
    });

    it('subsequent-version approve does NOT duplicate or clobber an existing listing', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ version: '0.2.0' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue({
        id: 'apb_existing',
        appId: 'oc_existing',
        repoUrl: 'https://forgejo.example/civitai-apps/hello',
        app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
      });
      // A listing already exists (minted on the first approve; a mod may since
      // have set category/featured). The guard must SKIP, never update.
      mockDbRead.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
      mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0' });

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      expect(result.appBlockId).toBe('apb_existing');
      expect(mockDbRead.appListing.findUnique).toHaveBeenCalledWith({
        where: { appBlockId: 'apb_existing' },
        select: { id: true },
      });
      // Skip-if-exists: no create. There is NO appListing.update path at all in
      // the approve flow, so curated fields (category/featured/featuredOrder)
      // cannot be clobbered on a re-approve.
      expect(mockDbWrite.appListing.create).not.toHaveBeenCalled();
      // The approve itself still completes (build triggered, request finalised).
      expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
    });

    it('transition case: subsequent-version approve with NO prior listing mints one mirroring the AppBlock curation + owner (not the current submitter)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        // This version submitted by user 42…
        pendingRequest({ manifest: manifest({ version: '0.2.0' }), submittedByUserId: 42 })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue({
        id: 'apb_existing',
        appId: 'oc_existing',
        repoUrl: 'https://forgejo.example/civitai-apps/hello',
        app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
      });
      // No listing yet (app approved BEFORE this feature; never backfilled).
      mockDbRead.appListing.findUnique.mockResolvedValue(null);
      // …but the AppBlock carries mod curation + its ORIGINAL owner (7 ≠ 42).
      mockDbWrite.appBlock.findUnique.mockImplementation(
        async (args: { where: { id: string } }) => ({
          id: args.where.id,
          blockId: 'hello',
          manifest: manifest({ version: '0.2.0' }),
          contentRating: 'g',
          category: 'productivity',
          featured: true,
          featuredOrder: 3,
          externalUrl: null,
          app: { userId: 7 },
        })
      );
      mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0' });

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);
      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        kind: 'onsite',
        appBlockId: 'apb_existing',
        category: 'productivity',
        featured: true,
        featuredOrder: 3,
        userId: 7, // the app owner, faithfully mirrored — NOT the submitter (42)
      });
    });

    it('absorbs a concurrent create (P2002) — approve still succeeds end-to-end', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();
      // Race: findUnique saw no listing, but the create loses to a concurrent
      // approve/backfill → P2002. Treated as a no-op skip, not a failure.
      mockDbRead.appListing.findUnique.mockResolvedValue(null);
      const p2002 = Object.assign(new Error('Unique constraint failed on appBlockId'), {
        code: 'P2002',
      });
      mockDbWrite.appListing.create.mockRejectedValueOnce(p2002);

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The P2002 did NOT abort the approve — commit, request-finalise, and build
      // all still ran.
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
      expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledOnce();
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
    });

    // TRANSACTION-BOUNDARY coverage. approveRequest is NOT a DB transaction (it
    // interleaves Forgejo/MinIO/Tekton I/O), so there is no literal rollback. The
    // listing is a CONVENIENCE and must NEVER gate the approve/deploy: a non-P2002
    // listing-create failure is logged and the approve CONTINUES. Idempotency
    // (skip-if-exists + P2002-absorb) means a retry never duplicates it.
    it('tx-boundary: a non-P2002 listing-create error does NOT abort the approve — commit/finalise/build still run, listing simply absent (backfill-recoverable)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();
      mockDbWrite.appListing.create.mockRejectedValueOnce(
        new Error('app_listings content_rating check violation')
      );

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The listing create was attempted and failed…
      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);
      // …but the approve proceeded end-to-end: commit, request-finalise, build.
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockDbWrite.appBlock.create).toHaveBeenCalledOnce();
      expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
      expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledOnce();
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
    });

    // The specific owner-deleted class the audit flagged: the AppBlock's owner
    // (OauthClient userId, which can differ from the submitter) deleted their
    // account → user_id FK violation on the listing insert. This must NOT wedge
    // the app's deploy forever — approve still succeeds, no listing minted.
    it('owner-deleted class: a user_id FK violation on the listing insert never blocks the deploy (approve succeeds, no listing)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();
      // Prisma P2003 = FK constraint failed (the deleted-owner user_id FK).
      const fkErr = Object.assign(new Error('Foreign key constraint failed on user_id'), {
        code: 'P2003',
      });
      mockDbWrite.appListing.create.mockRejectedValueOnce(fkErr);

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      expect(result.isFirstVersion).toBe(true);
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
      expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledOnce();
    });

    it('tx-boundary: listing is created once and survives a mid-flow commit failure without duplication on re-approve (retry convergence)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();

      // Attempt 1: listing IS created (no existing), THEN commitFiles fails, so
      // the approve throws with the request still 'pending' (never finalised).
      mockForgejo.commitFiles.mockRejectedValueOnce(new Error('Forgejo 503 on commit'));
      await expect(
        approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
      ).rejects.toThrow(/Forgejo 503/);
      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);

      // Attempt 2: the SAME still-pending request. OauthClient + AppBlock creates
      // P2002-recover to the existing rows (deterministic-id retry model), and the
      // listing now exists so the idempotency guard SKIPS it.
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst
        .mockResolvedValueOnce(null) // isFirstVersion check (race-window null)
        .mockResolvedValueOnce({ id: 'apb_first' }); // AppBlock.create P2002 recovery
      const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      mockDbWrite.oauthClient.create.mockRejectedValueOnce(p2002);
      mockDbRead.oauthClient.findUnique.mockResolvedValueOnce({ id: 'appblk-hello' });
      mockDbWrite.appBlock.create.mockRejectedValueOnce(p2002);
      mockDbRead.appListing.findUnique.mockResolvedValue({ id: 'apl_test_1' }); // now exists

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 998 });
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      // Still exactly ONE listing create across BOTH approves — no duplicate.
      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);
    });
  });

  // ---- W13: category-on-approve ------------------------------------------
  //
  // approveRequest now copies a VALIDATED manifest `category` onto
  // AppBlock.category so it flows to the auto-created (3b) store listing —
  // WITHOUT touching (3b) or the mapper (they already read AppBlock.category).
  // It's a targeted, NO-CLOBBER `updateMany` gated on `category: null`, run at
  // the PRIMARY right before the (3b) re-read (read-your-writes), so a mod's
  // curated category is never overridden and a manifest with no category leaves
  // the column null.
  describe('W13: category-on-approve (manifest category → AppBlock.category → listing)', () => {
    // Simulate the DB row's category column with no-clobber `updateMany`
    // (category set ONLY when currently null) feeding the (3b) findUnique
    // re-read — so the listing-create assertion is genuinely end-to-end, not a
    // tautology. `initial` is whatever category the row already carries.
    function simulateCategoryPersistence(initial: string | null) {
      const state: { category: string | null } = { category: initial };
      mockDbWrite.appBlock.updateMany.mockImplementation(
        async (args: { where: { category: unknown }; data: { category?: string } }) => {
          // Mirror the SQL `WHERE category IS NULL` gate: only set when null.
          if (state.category === null && typeof args.data.category === 'string') {
            state.category = args.data.category;
            return { count: 1 };
          }
          return { count: 0 };
        }
      );
      mockDbWrite.appBlock.findUnique.mockImplementation(
        async (args: { where: { id: string } }) => ({
          id: args.where.id,
          blockId: 'hello',
          manifest: manifest(),
          contentRating: 'g',
          category: state.category,
          featured: false,
          featuredOrder: null,
          externalUrl: null,
          app: { userId: 42 },
        })
      );
      return state;
    }

    it('first-version approve with a manifest category sets AppBlock.category (no-clobber gate) and the listing mirrors it', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ category: 'generation' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ category: 'generation' });
      const state = simulateCategoryPersistence(null);

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The category-set is a targeted, no-clobber updateMany gated on category=null.
      expect(mockDbWrite.appBlock.updateMany).toHaveBeenCalledWith({
        where: { id: result.appBlockId, category: null },
        data: { category: 'generation' },
      });
      expect(state.category).toBe('generation');
      // End-to-end: the auto-created onsite listing is categorised from the manifest.
      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);
      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data.category).toBe('generation');
    });

    it('no-clobber: a moderator-curated category is NOT overridden by a re-approve whose manifest declares a different one', async () => {
      const { approveRequest } = await import('../publish-request.service');
      // Subsequent-version approve; the manifest declares 'games'…
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ version: '0.2.0', category: 'games' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue({
        id: 'apb_existing',
        appId: 'oc_existing',
        repoUrl: 'https://forgejo.example/civitai-apps/hello',
        app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
      });
      // …but the row already carries the moderator's curated 'utility'. Use the
      // transition case (no prior listing) so a listing IS minted and we can
      // assert its category faithfully mirrors the curated value, not 'games'.
      mockDbRead.appListing.findUnique.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ version: '0.2.0', category: 'games' });
      const state = simulateCategoryPersistence('utility');

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The updateMany still runs (manifest has a category) but its null-gate
      // matches 0 rows, so the curated value survives.
      expect(mockDbWrite.appBlock.updateMany).toHaveBeenCalledWith({
        where: { id: 'apb_existing', category: null },
        data: { category: 'games' },
      });
      expect(state.category).toBe('utility');
      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data.category).toBe('utility');
    });

    it('manifest with NO category leaves AppBlock.category null (no updateMany, listing uncategorised)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();
      const state = simulateCategoryPersistence(null);

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // No manifest category ⇒ the category-set is skipped entirely.
      expect(mockDbWrite.appBlock.updateMany).not.toHaveBeenCalled();
      expect(state.category).toBeNull();
      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data.category).toBeNull();
    });

    it('tx-boundary: a transient category updateMany error does NOT abort the approve — commit/finalise/build still run, category simply unset (mirrors #3085 listing posture)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ category: 'generation' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ category: 'generation' });
      // The (3a) category-set hits a transient DB error. It FEEDS the convenience
      // listing, so — like the (3b) listing-create — it must log-and-continue,
      // never gate the approve/deploy.
      mockDbWrite.appBlock.updateMany.mockRejectedValueOnce(
        new Error('deadlock detected on app_blocks update')
      );
      // The (3b) re-read still returns a null category (the set never landed).
      mockDbWrite.appBlock.findUnique.mockImplementation(
        async (args: { where: { id: string } }) => ({
          id: args.where.id,
          blockId: 'hello',
          manifest: manifest(),
          contentRating: 'g',
          category: null,
          featured: false,
          featuredOrder: null,
          externalUrl: null,
          app: { userId: 42 },
        })
      );

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The category write was attempted and failed…
      expect(mockDbWrite.appBlock.updateMany).toHaveBeenCalledTimes(1);
      // …but the approve still COMPLETED end-to-end: commit + build + finalise.
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
      // The listing is still minted (its own create didn't fail), just uncategorised.
      expect(mockDbWrite.appListing.create).toHaveBeenCalledTimes(1);
      const data = mockDbWrite.appListing.create.mock.calls[0][0].data;
      expect(data.category).toBeNull();
    });

    it('rejects an approve whose manifest declares an unknown category (validator gate)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ category: 'not-a-category' }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ category: 'not-a-category' });

      await expect(
        approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 })
      ).rejects.toThrow(/Invalid manifest — cannot approve/);
      // Pre-validation fails before any category write or listing-create.
      expect(mockDbWrite.appBlock.updateMany).not.toHaveBeenCalled();
      expect(mockDbWrite.appListing.create).not.toHaveBeenCalled();
    });
  });

  // ---- W4: per-app storage provisioning-on-approve -----------------------
  //
  // approveRequest now provisions the app's appsDb schema (kv / quota /
  // shared_kv / votes / counters / shared_kv_reports + triggers + role) at
  // approve — but ONLY when the approved manifest declares any `apps:storage:*`
  // scope — so a storage-declaring app has its datastore the moment it deploys,
  // without a manual `/api/admin/apps-storage-backfill` run. It reuses the SAME
  // `sanitizeAppSlug(blockId)` derivation the backfill uses, is idempotent
  // (CREATE ... IF NOT EXISTS DDL), and — like (3a)/(3b)/#3085/#3089 — it
  // log-and-continues on ANY error so provisioning can NEVER gate the deploy.
  describe('W4: storage provisioning-on-approve', () => {
    it('provisions the appsDb schema ONCE for a storage-declaring app with slug = sanitized blockId', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ scopes: ['apps:storage:read', 'apps:storage:write'] }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({
        scopes: ['apps:storage:read', 'apps:storage:write'],
      });

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // Provisioned exactly once, with the appBlockId of the freshly-created row
      // and the sanitized slug (blockId 'hello' → schema slug 'hello').
      expect(mockProvision).toHaveBeenCalledTimes(1);
      expect(mockProvision).toHaveBeenCalledWith({ appBlockId: result.appBlockId, slug: 'hello' });
      // The approve itself completed end-to-end.
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
    });

    it('provisions for a SHARED-storage-only app (apps:storage:shared:*)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ scopes: ['apps:storage:shared:read'] }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ scopes: ['apps:storage:shared:read'] });

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      expect(mockProvision).toHaveBeenCalledTimes(1);
      expect(mockProvision).toHaveBeenCalledWith({ appBlockId: result.appBlockId, slug: 'hello' });
    });

    it('derives the schema slug from the blockId via sanitizeAppSlug (hyphens → underscores)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      // blockId 'my-cool-app' → appsDb schema slug 'my_cool_app' (hyphens folded).
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({
          slug: 'my-cool-app',
          manifest: manifest({ blockId: 'my-cool-app', scopes: ['apps:storage:write'] }),
        })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({
        blockId: 'my-cool-app',
        scopes: ['apps:storage:write'],
      });

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      expect(mockProvision).toHaveBeenCalledWith({
        appBlockId: result.appBlockId,
        slug: 'my_cool_app',
      });
    });

    it('does NOT provision a non-storage app (declares only ai:write:budgeted)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ scopes: ['ai:write:budgeted'] }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ scopes: ['ai:write:budgeted'] });

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // Gen-only app never touches the datastore → no empty 6-table schema minted.
      expect(mockProvision).not.toHaveBeenCalled();
      // …and the approve still completes normally.
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
    });

    it('does NOT provision an app with no scopes at all (default manifest)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle();

      await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      expect(mockProvision).not.toHaveBeenCalled();
    });

    // TRANSACTION-BOUNDARY / log-and-continue coverage (mirrors the (3b)/(3a)
    // tx-boundary tests): provisioning is a side effect that must NEVER gate the
    // approve/deploy. A provision() throw is logged and the approve CONTINUES.
    it('tx-boundary: a provision() error does NOT abort the approve — commit/finalise/build still run (backfill-recoverable)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({ manifest: manifest({ scopes: ['apps:storage:read'] }) })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockBundleBuffer.current = await makeValidBundle({ scopes: ['apps:storage:read'] });
      // The appsDb DDL fails (e.g. cnpg-cluster-apps briefly unavailable).
      mockProvision.mockRejectedValueOnce(new Error('cnpg-cluster-apps: connection refused'));

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // The provision was attempted and failed…
      expect(mockProvision).toHaveBeenCalledTimes(1);
      // …but the approve proceeded end-to-end: AppBlock create, commit, finalise, build.
      expect(result.forgejoCommitSha).toBe('commit_sha_abc');
      expect(mockDbWrite.appBlock.create).toHaveBeenCalledOnce();
      expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
      expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledOnce();
      expect(mockTriggerBuild).toHaveBeenCalledOnce();
    });

    it('idempotency: a subsequent-version re-approve provisions again (safe — CREATE ... IF NOT EXISTS)', async () => {
      const { approveRequest } = await import('../publish-request.service');
      mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
        pendingRequest({
          manifest: manifest({ version: '0.2.0', scopes: ['apps:storage:read'] }),
        })
      );
      mockDbRead.appBlock.findFirst.mockResolvedValue({
        id: 'apb_existing',
        appId: 'oc_existing',
        repoUrl: 'https://forgejo.example/civitai-apps/hello',
        app: { allowedScopes: 33554431, allowedOrigins: ['https://hello.civit.ai'] },
      });
      mockBundleBuffer.current = await makeValidBundle({
        version: '0.2.0',
        scopes: ['apps:storage:read'],
      });

      const result = await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

      // Re-runs the idempotent DDL against the EXISTING app block's id + slug.
      expect(result.appBlockId).toBe('apb_existing');
      expect(mockProvision).toHaveBeenCalledTimes(1);
      expect(mockProvision).toHaveBeenCalledWith({ appBlockId: 'apb_existing', slug: 'hello' });
    });
  });
});

// ---- rejectRequest ---------------------------------------------------------

describe('rejectRequest', () => {
  it('happy path moves pending → rejected with reason', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
    });
    await rejectRequest({
      publishRequestId: 'pubreq_x',
      reviewerUserId: 999,
      rejectionReason: 'manifest contentRating mismatch — please file as adult',
    });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe('rejected');
    expect(updateArg.data.reviewedByUserId).toBe(999);
    expect(updateArg.data.rejectionReason).toBe(
      'manifest contentRating mismatch — please file as adult'
    );
    expect(updateArg.data.reviewedAt).toBeInstanceOf(Date);
  });

  it('trims the rejection reason', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
    });
    await rejectRequest({
      publishRequestId: 'pubreq_x',
      reviewerUserId: 999,
      rejectionReason: '   short but valid here   ',
    });
    const updateArg = mockDbWrite.appBlockPublishRequest.update.mock.calls[0][0];
    expect(updateArg.data.rejectionReason).toBe('short but valid here');
  });

  it('rejects reasons shorter than the shared min (3) after trim', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    await expect(
      rejectRequest({
        publishRequestId: 'pubreq_x',
        reviewerUserId: 999,
        rejectionReason: '  no  ',
      })
    ).rejects.toThrow(/at least 3 characters/);
  });

  it('rejects reasons longer than 2000 characters', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    await expect(
      rejectRequest({
        publishRequestId: 'pubreq_x',
        reviewerUserId: 999,
        rejectionReason: 'x'.repeat(2001),
      })
    ).rejects.toThrow(/at most 2000/);
  });

  it('rejects when request is not pending', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'approved',
    });
    await expect(
      rejectRequest({
        publishRequestId: 'pubreq_x',
        reviewerUserId: 999,
        rejectionReason: 'manifest contentRating mismatch — adult content not labeled',
      })
    ).rejects.toThrow(/cannot reject a request in status approved/);
  });

  it('rejects when request not found', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      rejectRequest({
        publishRequestId: 'pubreq_x',
        reviewerUserId: 999,
        rejectionReason: 'manifest contentRating mismatch — adult content not labeled',
      })
    ).rejects.toThrow(/not found/);
  });
});

// ---- backfillPublishRequest -----------------------------------------------

describe('backfillPublishRequest', () => {
  beforeEach(() => {
    mockForgejo.getRepo.mockResolvedValue({
      id: 1,
      name: 'hello',
      full_name: 'civitai-apps/hello',
      html_url: 'https://forgejo.example/civitai-apps/hello',
      clone_url: '',
      ssh_url: '',
      default_branch: 'main',
    });
  });

  it('happy path: pulls Forgejo state into a fresh bundle and inserts an approved row', async () => {
    const { backfillPublishRequest } = await import('../publish-request.service');
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      manifest: manifest(),
      version: '0.1.0',
      currentVersionSha: 'sha_in_repo',
      app: { userId: 42 },
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null); // not already backfilled
    mockForgejo.listRepoTreeAtRef.mockResolvedValue(
      new Map([
        ['block.manifest.json', 'blob1'],
        ['index.html', 'blob2'],
      ])
    );
    mockForgejo.getBlobContent.mockImplementation(async (_slug: string, sha: string) => {
      if (sha === 'blob1') return Buffer.from(JSON.stringify(manifest()));
      return Buffer.from('<!doctype html>');
    });

    const result = await backfillPublishRequest({
      slug: 'hello',
      reviewerUserId: 999,
    });

    expect(result.fileCount).toBe(2);
    expect(result.appBlockId).toBe('apb_existing');
    expect(result.forgejoCommitSha).toBe('sha_in_repo');

    // A row was inserted with status='approved' and ownership attribution to the
    // original app owner (not the mod running the backfill).
    const createArg = mockDbWrite.appBlockPublishRequest.create.mock.calls[0][0].data;
    expect(createArg.status).toBe('approved');
    expect(createArg.submittedByUserId).toBe(42);
    expect(createArg.reviewedByUserId).toBe(999);
    expect(createArg.forgejoCommitSha).toBe('sha_in_repo');
  });

  it('idempotent: re-running with the same Forgejo HEAD returns the existing row', async () => {
    const { backfillPublishRequest } = await import('../publish-request.service');
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      manifest: manifest(),
      version: '0.1.0',
      currentVersionSha: 'sha_in_repo',
      app: { userId: 42 },
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      id: 'pubreq_already_backfilled',
      appBlockId: 'apb_existing',
      bundleSizeBytes: 12345n,
    });
    mockForgejo.listRepoTreeAtRef.mockResolvedValue(new Map([['block.manifest.json', 'blob1']]));
    mockForgejo.getBlobContent.mockResolvedValue(Buffer.from(JSON.stringify(manifest())));

    const result = await backfillPublishRequest({
      slug: 'hello',
      reviewerUserId: 999,
    });

    expect(result.publishRequestId).toBe('pubreq_already_backfilled');
    expect(mockDbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  it('throws when the AppBlock row is missing', async () => {
    const { backfillPublishRequest } = await import('../publish-request.service');
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    await expect(backfillPublishRequest({ slug: 'hello', reviewerUserId: 999 })).rejects.toThrow(
      /nothing to backfill/
    );
  });

  // M-4 regression — empty Forgejo repo throws the opaque "bundle is empty"
  // error from extractBundleMetadata; should be flipped when a friendlier
  // error message is added.
  it('REGRESSION (M-4): empty Forgejo repo throws opaque "empty bundle" error', async () => {
    const { backfillPublishRequest } = await import('../publish-request.service');
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      manifest: manifest(),
      version: '0.1.0',
      currentVersionSha: 'sha_in_repo',
      app: { userId: 42 },
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    mockForgejo.listRepoTreeAtRef.mockResolvedValue(new Map());

    await expect(backfillPublishRequest({ slug: 'hello', reviewerUserId: 999 })).rejects.toThrow(
      /empty/
    );
  });
});

// ---- reconstructBundleFromForgejo ------------------------------------------

describe('reconstructBundleFromForgejo', () => {
  it('builds a non-empty ZIP Buffer from the repo tree + blobs at the ref', async () => {
    const { reconstructBundleFromForgejo } = await import('../publish-request.service');
    mockForgejo.listRepoTreeAtRef.mockResolvedValue(
      new Map([
        ['block.manifest.json', 'blobM'],
        ['index.html', 'blobH'],
      ])
    );
    mockForgejo.getBlobContent.mockImplementation(async (_slug: string, sha: string) => {
      if (sha === 'blobM') return Buffer.from(JSON.stringify(manifest()));
      return Buffer.from('<!doctype html>');
    });

    const buf = await reconstructBundleFromForgejo('hello', 'pushsha123');

    // Resolved the tree at the exact ref (sha), not a branch.
    expect(mockForgejo.listRepoTreeAtRef).toHaveBeenCalledWith('hello', 'pushsha123');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    // The reconstructed ZIP round-trips to the expected file set.
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).sort()).toEqual(['block.manifest.json', 'index.html']);
  });

  it('is deterministic — identical repo state yields byte-identical bytes', async () => {
    const { reconstructBundleFromForgejo } = await import('../publish-request.service');
    // Tree entry order is reversed between the two runs to prove the helper
    // sorts entries (so Forgejo ordering can't change the resulting bytes).
    mockForgejo.getBlobContent.mockImplementation(async (_slug: string, sha: string) => {
      if (sha === 'blobM') return Buffer.from(JSON.stringify(manifest()));
      return Buffer.from('<!doctype html>');
    });

    mockForgejo.listRepoTreeAtRef.mockResolvedValueOnce(
      new Map([
        ['block.manifest.json', 'blobM'],
        ['index.html', 'blobH'],
      ])
    );
    const a = await reconstructBundleFromForgejo('hello', 'pushsha123');

    mockForgejo.listRepoTreeAtRef.mockResolvedValueOnce(
      new Map([
        ['index.html', 'blobH'],
        ['block.manifest.json', 'blobM'],
      ])
    );
    const b = await reconstructBundleFromForgejo('hello', 'pushsha123');

    expect(a.equals(b)).toBe(true);
  });
});

// ---- recordPendingFromPush -------------------------------------------------
//
// The no-trust-on-push recorder: a direct git push OR the web manifest editor
// parks a `pending` review row for an UNREVIEWED (slug, sha) commit. The
// riskiest branch is the P2002 same-commit race catch (the fix this PR adds):
// the loser of a concurrent create re-reads the winner's pending row and
// returns its id instead of throwing. The router tests mock this function at
// the module boundary, so these are its only direct tests.
//
// P2002 is faked with the file-local idiom (`Object.assign(new Error(), { code:
// 'P2002' })`) — the service only inspects `err.code === 'P2002'`, matching the
// spend-attribution.service.test.ts FakePrismaKnownError pattern.
describe('recordPendingFromPush', () => {
  const pushArgs = {
    slug: 'hello',
    sha: 'pushsha-abc',
    appBlockId: 'apb_hello',
    manifest: manifest(),
    version: '0.1.0',
  };

  // The supersede→create happy path fires `enrichPushRequestRow` fire-and-forget
  // (void + .catch). Point its Forgejo tree at an empty Map so the async enrich
  // resolves harmlessly off the response path and never leaks an unhandled
  // rejection into the assertions (it has its own try/catch + is .catch()'d).
  function stubEnrichForgejoNoop() {
    mockForgejo.listRepoTreeAtRef.mockResolvedValue(new Map());
    mockForgejo.getBlobContent.mockResolvedValue(Buffer.from(''));
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
  }

  it('(a) existingForSha refresh path — updates the existing (slug,sha) pending row, no create', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    // A pending row for THIS exact (slug, sha) already exists → refresh + done.
    mockDbWrite.appBlockPublishRequest.findFirst.mockResolvedValueOnce({ id: 'pubreq_existing_sha' });
    mockDbWrite.appBlockPublishRequest.update.mockResolvedValue(undefined);

    const res = await recordPendingFromPush(pushArgs);

    expect(res.publishRequestId).toBe('pubreq_existing_sha');
    // Refreshed the existing row's manifest/version/appBlockId, no new create.
    expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pubreq_existing_sha' },
        data: expect.objectContaining({
          manifest: pushArgs.manifest,
          version: pushArgs.version,
          appBlockId: pushArgs.appBlockId,
        }),
      })
    );
    expect(mockDbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    // No supersede, no owner lookup — the early-return short-circuits them.
    expect(mockDbWrite.appBlockPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });

  it('(b) supersede-then-create happy path — no existing row → supersedes other pending, then creates', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    stubEnrichForgejoNoop();
    // No existing (slug,sha) pending row.
    mockDbWrite.appBlockPublishRequest.findFirst.mockResolvedValueOnce(null);
    mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValueOnce({ count: 1 }); // supersede
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 777 } });
    mockDbWrite.appBlockPublishRequest.create.mockResolvedValue(undefined);

    const res = await recordPendingFromPush(pushArgs);

    // newUlid() runs once in beforeEach reset → first id is ...001.
    expect(res.publishRequestId).toBe('pubreq_00000000000000000000000001');

    // Superseded any OTHER still-pending request for the slug, THEN created.
    expect(mockDbWrite.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: pushArgs.slug, status: 'pending' },
        data: { status: 'withdrawn' },
      })
    );
    expect(mockDbWrite.appBlockPublishRequest.create).toHaveBeenCalledOnce();
    const createArg = mockDbWrite.appBlockPublishRequest.create.mock.calls[0][0];
    expect(createArg.data.status).toBe('pending');
    expect(createArg.data.slug).toBe(pushArgs.slug);
    expect(createArg.data.forgejoCommitSha).toBe(pushArgs.sha);
    expect(createArg.data.submittedByUserId).toBe(777); // resolved owner userId
    // Push-originated marker: empty bundle pointers.
    expect(createArg.data.bundleKey).toBe('');
    expect(createArg.data.bundleSha256).toBe('');
  });

  it('(c) create throws P2002 → re-reads the EXACT-sha winner and returns its id', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    stubEnrichForgejoNoop();
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    // findFirst calls in order: (1) existingForSha (null) → falls through to
    // create; create P2002s; (2) re-read exact-sha winner → found.
    mockDbWrite.appBlockPublishRequest.findFirst
      .mockResolvedValueOnce(null) // existingForSha miss
      .mockResolvedValueOnce({ id: 'pubreq_winner_sha' }); // exact-sha winner on re-read
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 777 } });
    mockDbWrite.appBlockPublishRequest.create.mockRejectedValueOnce(p2002);

    const res = await recordPendingFromPush(pushArgs);

    expect(res.publishRequestId).toBe('pubreq_winner_sha');
    // Re-read was keyed on the exact (slug, sha).
    expect(mockDbWrite.appBlockPublishRequest.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { slug: pushArgs.slug, status: 'pending', forgejoCommitSha: pushArgs.sha },
      })
    );
  });

  it('(d) P2002 + only a DIFFERENT-sha pending row exists → returns that fallback row id', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    stubEnrichForgejoNoop();
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    // findFirst: (1) existingForSha miss; (2) exact-sha winner miss (null);
    // (3) any-pending-for-slug fallback → the winner parked a NEWER sha.
    mockDbWrite.appBlockPublishRequest.findFirst
      .mockResolvedValueOnce(null) // existingForSha miss
      .mockResolvedValueOnce(null) // exact-sha re-read miss
      .mockResolvedValueOnce({ id: 'pubreq_newer_sha' }); // any-pending fallback
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 777 } });
    mockDbWrite.appBlockPublishRequest.create.mockRejectedValueOnce(p2002);

    const res = await recordPendingFromPush(pushArgs);

    expect(res.publishRequestId).toBe('pubreq_newer_sha');
    // Third findFirst is the slug-only fallback (no forgejoCommitSha filter).
    expect(mockDbWrite.appBlockPublishRequest.findFirst).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ where: { slug: pushArgs.slug, status: 'pending' } })
    );
  });

  it('(e) P2002 but NO pending row visible on re-read → re-throws', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    stubEnrichForgejoNoop();
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    // Both re-reads miss → the index fired but no pending row is visible.
    mockDbWrite.appBlockPublishRequest.findFirst
      .mockResolvedValueOnce(null) // existingForSha miss
      .mockResolvedValueOnce(null) // exact-sha re-read miss
      .mockResolvedValueOnce(null); // any-pending fallback miss
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 777 } });
    mockDbWrite.appBlockPublishRequest.create.mockRejectedValueOnce(p2002);

    await expect(recordPendingFromPush(pushArgs)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a non-P2002 create error is re-thrown unchanged (real failures are not swallowed)', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    stubEnrichForgejoNoop();
    const dbErr = Object.assign(new Error('connection lost'), { code: 'P1001' });
    mockDbWrite.appBlockPublishRequest.findFirst.mockResolvedValueOnce(null); // existingForSha miss
    mockDbRead.appBlock.findUnique.mockResolvedValue({ app: { userId: 777 } });
    mockDbWrite.appBlockPublishRequest.create.mockRejectedValueOnce(dbErr);

    await expect(recordPendingFromPush(pushArgs)).rejects.toMatchObject({ code: 'P1001' });
    // Did NOT fall through to the P2002 winner re-read (only the existingForSha
    // findFirst ran).
    expect(mockDbWrite.appBlockPublishRequest.findFirst).toHaveBeenCalledOnce();
  });
});

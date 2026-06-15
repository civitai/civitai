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
} = vi.hoisted(() => {
  const ulidSeq: { i: number } = { i: 0 };
  return {
    mockDbRead: {
      appBlockPublishRequest: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      appBlock: { findFirst: vi.fn() },
      user: { findUnique: vi.fn() },
      // Added 2026-05-28 for C-2 fix: approveRequest now reads the
      // OauthClient row after a P2002 collision to recover the existing
      // client on retry.
      oauthClient: { findUnique: vi.fn() },
    },
    mockDbWrite: {
      // `updateMany` added (no-trust-on-push fix): approveRequest now supersedes
      // any stray pending review request the git-push webhook may have parked for
      // the slug while racing the approve commit.
      appBlockPublishRequest: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      appBlock: { create: vi.fn(), update: vi.fn() },
      // `update` added 2026-06-02 (audit A1 fix): approveRequest now re-caps
      // the app-block OauthClient's allowedScopes to the manifest-derived
      // ceiling + forces grants:[] on the subsequent-version + P2002-retry
      // paths.
      oauthClient: { create: vi.fn(), update: vi.fn() },
    },
    mockS3Send: vi.fn(),
    mockBundleBuffer: { current: null as Buffer | null },
    mockForgejo: {
      createRepoFromTemplate: vi.fn(),
      ensurePushWebhook: vi.fn(),
      commitFiles: vi.fn(),
      listRepoTree: vi.fn(),
      getBlobContent: vi.fn(),
      getRepo: vi.fn(),
      ensureReviewRepo: vi.fn(),
      // setCommitStatus added (no-trust-on-push fix): approveRequest now drives
      // the build trigger itself + pends/marks the commit status.
      setCommitStatus: vi.fn(),
      reviewRepoUrl: vi.fn((slug: string) => `https://forgejo.example/civitai-apps-review/${slug}`),
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
  };
});

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

vi.mock('~/server/utils/app-block-ids', () => ({
  newUlid: mockNewUlid,
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
  mockDbWrite.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 0 });
  mockDbWrite.appBlock.update.mockResolvedValue(undefined);

  // Default: no pending conflict, no existing app block, user lookup OK.
  mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  mockDbRead.appBlock.findFirst.mockResolvedValue(null);
  mockDbRead.user.findUnique.mockResolvedValue({ username: 'tester' });
  mockDbWrite.appBlockPublishRequest.create.mockResolvedValue({ id: 'will-be-overwritten' });

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
      /you already have a pending submission for slug .* \(pubreq_existing\); withdraw it/
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
  it('moves pending → withdrawn for the owner', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 42,
    });
    await withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 });
    expect(mockDbWrite.appBlockPublishRequest.update).toHaveBeenCalledWith({
      where: { id: 'pubreq_x' },
      data: { status: 'withdrawn' },
    });
  });

  it('is idempotent on already-withdrawn', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'withdrawn',
      submittedByUserId: 42,
    });
    await withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 });
    expect(mockDbWrite.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('throws for a request owned by a different user', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'pending',
      submittedByUserId: 1,
    });
    await expect(withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })).rejects.toThrow(
      /can only withdraw your own/
    );
  });

  it('throws for already-approved', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'approved',
      submittedByUserId: 42,
    });
    await expect(withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })).rejects.toThrow(
      /cannot withdraw a request in status approved/
    );
  });

  it('throws for already-rejected', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'rejected',
      submittedByUserId: 42,
    });
    await expect(withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })).rejects.toThrow(
      /cannot withdraw a request in status rejected/
    );
  });

  it('throws when the request is not found', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })).rejects.toThrow(
      /not found/
    );
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

  it('rejects reasons shorter than 10 characters (after trim)', async () => {
    const { rejectRequest } = await import('../publish-request.service');
    await expect(
      rejectRequest({
        publishRequestId: 'pubreq_x',
        reviewerUserId: 999,
        rejectionReason: '   short   ',
      })
    ).rejects.toThrow(/at least 10 characters/);
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
    mockForgejo.listRepoTree.mockResolvedValue(
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
    mockForgejo.listRepoTree.mockResolvedValue(new Map([['block.manifest.json', 'blob1']]));
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
    mockForgejo.listRepoTree.mockResolvedValue(new Map());

    await expect(backfillPublishRequest({ slug: 'hello', reviewerUserId: 999 })).rejects.toThrow(
      /empty/
    );
  });
});

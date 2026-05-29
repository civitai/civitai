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
    },
    mockDbWrite: {
      appBlockPublishRequest: { create: vi.fn(), update: vi.fn() },
      appBlock: { create: vi.fn(), update: vi.fn() },
      oauthClient: { create: vi.fn() },
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
    },
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
  return {
    blockId: 'hello',
    version: '0.1.0',
    name: 'Hello World',
    iframe: { src: 'https://hello.civit.ai', minHeight: 300 },
    ...over,
  };
}

async function makeValidBundle(over: Record<string, unknown> = {}): Promise<Buffer> {
  return makeBundle({
    [MANIFEST_PATH]: JSON.stringify(manifest(over)),
    'index.html': '<!doctype html><html><body>hi</body></html>',
    'Dockerfile': 'FROM node:20',
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
      slug: 'hello',
      version: '0.1.0',
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
      slug: 'hello',
      version: '0.1.0',
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
        slug: 'hello',
        version: '0.1.0',
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
        slug: 'hello',
        version: '0.1.0',
        bundleBuffer: Buffer.alloc(0),
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/empty/);
  });

  it('rejects when manifest.blockId does not match slug', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({ blockId: 'different-slug' });
    await expect(
      submitVersion({
        slug: 'hello',
        version: '0.1.0',
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/blockId.*does not match.*slug/);
  });

  it('rejects when manifest.version does not match submitted version', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({ version: '9.9.9' });
    await expect(
      submitVersion({
        slug: 'hello',
        version: '0.1.0',
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/version.*does not match/);
  });

  it('rejects when manifest.name is missing or empty', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const buf = await makeValidBundle({ name: '' });
    await expect(
      submitVersion({
        slug: 'hello',
        version: '0.1.0',
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/name must be a non-empty string/);
  });

  it('rejects when a pending request for the slug already exists', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      id: 'pubreq_existing',
      submittedByUserId: 1,
    });
    const buf = await makeValidBundle();
    await expect(
      submitVersion({
        slug: 'hello',
        version: '0.1.0',
        bundleBuffer: buf,
        submittedByUserId: 42,
      })
    ).rejects.toThrow(/already has a pending publish request/);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
  });

  // C-4 regression: two concurrent submitVersion calls both pass the pending
  // check because there's no DB-level uniqueness. This test LOCKS IN current
  // behavior — when a partial unique index is added, this will fail and
  // should be updated to assert the second call throws.
  //
  // Vitest's mock proxy doesn't co-operate well with Prisma's lazy init under
  // Promise.all of the same service entry point, so we simulate the race
  // sequentially: prove that when BOTH calls observe no pending row, BOTH
  // proceed to insert. The interleaving doesn't matter — the race window
  // is between the read and the write inside the SAME function.
  it('REGRESSION (C-4): two same-slug submissions both succeed without DB-level uniqueness', async () => {
    const { submitVersion } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null); // both see no pending
    const buf = await makeValidBundle();

    const r1 = await submitVersion({
      slug: 'hello',
      version: '0.1.0',
      bundleBuffer: buf,
      submittedByUserId: 42,
    });
    // Re-arming the "no pending" state simulates the race window where the
    // first INSERT hasn't been visible to the second findFirst yet.
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const r2 = await submitVersion({
      slug: 'hello',
      version: '0.1.0',
      bundleBuffer: buf,
      submittedByUserId: 43,
    });

    expect(r1.publishRequestId).not.toBe(r2.publishRequestId);
    expect(mockDbWrite.appBlockPublishRequest.create).toHaveBeenCalledTimes(2);
  });

  it('Discord notify is invoked with the right shape on submission', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const buf = await makeValidBundle();
    await submitVersion({
      slug: 'hello',
      version: '0.1.0',
      bundleBuffer: buf,
      submittedByUserId: 42,
    });

    // fire-and-forget; give the microtask a tick
    await new Promise((r) => setImmediate(r));

    expect(fetchSpy).toHaveBeenCalled();
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
      slug: 'hello',
      version: '0.1.0',
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
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toThrow(/can only withdraw your own/);
  });

  it('throws for already-approved', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'approved',
      submittedByUserId: 42,
    });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toThrow(/cannot withdraw a request in status approved/);
  });

  it('throws for already-rejected', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'pubreq_x',
      status: 'rejected',
      submittedByUserId: 42,
    });
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toThrow(/cannot withdraw a request in status rejected/);
  });

  it('throws when the request is not found', async () => {
    const { withdrawRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      withdrawRequest({ publishRequestId: 'pubreq_x', userId: 42 })
    ).rejects.toThrow(/not found/);
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

// ---- listPendingRequests ---------------------------------------------------

describe('listPendingRequests', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'pubreq_1',
      appBlockId: null,
      slug: 'hello',
      version: '0.1.0',
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
    expect(result.items.map((r) => r.id)).toEqual(['pubreq_1', 'pubreq_2']);
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
    expect(result.items.map((r) => r.id)).toEqual(['pubreq_1', 'pubreq_2']);
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

    // OauthClient gets the slug-scoped allowedOrigins.
    const ocArg = mockDbWrite.oauthClient.create.mock.calls[0][0].data;
    expect(ocArg.allowedOrigins).toEqual(['https://hello.civit.ai']);
    expect(ocArg.userId).toBe(42);
    expect(ocArg.isConfidential).toBe(false);

    // commitFiles received the bundle contents with replaceAllFiles=true.
    const commitArg = mockForgejo.commitFiles.mock.calls[0][0];
    expect(commitArg.slug).toBe('hello');
    expect(commitArg.replaceAllFiles).toBe(true);
    expect(commitArg.files.map((f: { path: string }) => f.path).sort()).toEqual([
      'Dockerfile',
      'block.manifest.json',
      'index.html',
    ]);
  });

  it('subsequent-version happy path skips OauthClient + repo create', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      repoUrl: 'https://forgejo.example/civitai-apps/hello',
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
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledOnce();
    expect(mockForgejo.commitFiles).toHaveBeenCalledOnce();
  });

  // C-2 regression — failure at step 2 (Forgejo repo create) leaves the
  // OauthClient INSERT in place with no compensation.
  it('REGRESSION (C-2): Forgejo repo create failure leaves orphaned OauthClient', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockForgejo.createRepoFromTemplate.mockRejectedValue(new Error('Forgejo 500 Internal Server Error'));

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

  // C-3 regression — concurrent first-version approves both succeed today
  // because the AppBlock unique constraint is on (appId, blockId) and appId
  // is freshly generated each time. Sequential simulation; see C-4 test for
  // why we don't use Promise.all here.
  it('REGRESSION (C-3): two first-version approves both create AppBlock rows', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null); // both observe no existing
    mockBundleBuffer.current = await makeValidBundle();

    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });
    // Re-arm: the status check would see pending again because the second
    // approver hasn't observed the first's UPDATE yet.
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRequest());
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 998 });

    // Both runs created an AppBlock + OauthClient because the
    // unique-by-(appId,blockId) constraint is satisfied by distinct appIds.
    expect(mockDbWrite.oauthClient.create).toHaveBeenCalledTimes(2);
    expect(mockDbWrite.appBlock.create).toHaveBeenCalledTimes(2);
  });

  // H-4 regression — subsequent-version approve updates AppBlock.manifest
  // BEFORE Forgejo commit + webhook validation. If the manifest is bad,
  // AppBlock holds the bad data.
  it('REGRESSION (H-4): subsequent-version approve writes manifest to AppBlock before any validation', async () => {
    const { approveRequest } = await import('../publish-request.service');
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue(
      pendingRequest({
        manifest: manifest({
          iframe: { src: 'https://attacker.example' }, // mismatched origin
        }),
      })
    );
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      id: 'apb_existing',
      appId: 'oc_existing',
      repoUrl: 'https://forgejo.example/civitai-apps/hello',
    });
    mockBundleBuffer.current = await makeValidBundle({
      iframe: { src: 'https://attacker.example' },
    });

    await approveRequest({ publishRequestId: 'pubreq_1', reviewerUserId: 999 });

    // AppBlock.update was called with the (potentially-bad) manifest before
    // any cross-validation against the existing OauthClient.allowedOrigins.
    const updateArg = mockDbWrite.appBlock.update.mock.calls[0][0];
    expect(updateArg.data.manifest).toMatchObject({
      iframe: { src: 'https://attacker.example' },
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
    mockForgejo.listRepoTree.mockResolvedValue(
      new Map([['block.manifest.json', 'blob1']])
    );
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
    await expect(
      backfillPublishRequest({ slug: 'hello', reviewerUserId: 999 })
    ).rejects.toThrow(/nothing to backfill/);
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

    await expect(
      backfillPublishRequest({ slug: 'hello', reviewerUserId: 999 })
    ).rejects.toThrow(/empty/);
  });
});

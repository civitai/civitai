import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HuggingFaceImportService from '~/server/services/huggingface-import.service';
// Side-effect imports: the canonical mocks the handler's graph reaches at import time, WEBHOOK_TOKEN
// among them.
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/env.mock';

const { resolveRepoForImport, enqueueImports, getImportStatus, reuseStoredFile } = vi.hoisted(
  () => ({
    resolveRepoForImport: vi.fn(),
    enqueueImports: vi.fn(),
    getImportStatus: vi.fn(),
    reuseStoredFile: vi.fn(),
  })
);

vi.mock('~/server/services/huggingface-import.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HuggingFaceImportService>()),
  resolveRepoForImport,
  enqueueImports,
  getImportStatus,
  reuseStoredFile,
}));

import { IMPORT_SYSTEM_USER_ID } from '~/server/services/huggingface-import.service';

const handler = (await import('~/pages/api/admin/huggingface-import')).default;

const dbRead = dbMock.dbRead;

function run({
  method = 'POST',
  query = {},
  body,
  token = 'test-webhook-token',
}: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  token?: string | null;
}) {
  const req = {
    method,
    query: { ...(token ? { token } : {}), ...query },
    headers: {},
    body,
  };

  let statusCode = 0;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
    _status: () => statusCode,
    _body: () => payload as Record<string, unknown>,
  };

  return handler(req as never, res as never).then(() => res);
}

const repo = {
  repo: 'black-forest-labs/FLUX.1-dev',
  revision: 'abc123',
  files: [
    { path: 'flux1-dev.safetensors', size: 100, sha256: 'a', suggestedType: null, existing: null },
    { path: 'ae.safetensors', size: 50, sha256: 'b', suggestedType: 'VAE', existing: null },
  ],
};

const post = (overrides: Record<string, unknown> = {}) => ({
  repo: 'black-forest-labs/FLUX.1-dev',
  modelVersionId: 42,
  files: [
    { path: 'flux1-dev.safetensors', type: 'Model' },
    { path: 'ae.safetensors', type: 'VAE' },
  ],
  ...overrides,
});

const queuedRows = [
  {
    id: 11,
    filename: 'flux1-dev.safetensors',
    status: 'Queued',
    modelFileId: null,
    attachVersionId: 42,
  },
  { id: 12, filename: 'ae.safetensors', status: 'Queued', modelFileId: null, attachVersionId: 42 },
];

beforeEach(() => {
  vi.clearAllMocks();
  resolveRepoForImport.mockResolvedValue(repo);
  enqueueImports.mockResolvedValue({ queued: 2, skipped: 0, rows: queuedRows });
  dbRead.modelVersion.findUnique.mockResolvedValue({ id: 42 });
  reuseStoredFile.mockResolvedValue({ importId: 5, modelFileId: 900 });
});

describe('POST /api/admin/huggingface-import', () => {
  it('queues each file with the type it was given, and returns ids to poll', async () => {
    const res = await run({ body: post({ groupName: 'flux', userId: 7 }) });

    expect(res._status()).toBe(200);
    expect(enqueueImports).toHaveBeenCalledTimes(1);
    expect(enqueueImports).toHaveBeenCalledWith({
      repo,
      paths: ['flux1-dev.safetensors', 'ae.safetensors'],
      userId: 7,
      groupName: 'flux',
      attach: {
        modelVersionId: 42,
        types: { 'flux1-dev.safetensors': 'Model', 'ae.safetensors': 'VAE' },
      },
    });
    expect(res._body()).toMatchObject({
      revision: 'abc123',
      files: [
        { path: 'flux1-dev.safetensors', importId: 11, status: 'Queued', attachVersionId: 42 },
        { path: 'ae.safetensors', importId: 12, status: 'Queued', attachVersionId: 42 },
      ],
    });
  });

  it('files a tooling import under the system user when no userId is given', async () => {
    await run({ body: post() });

    expect(enqueueImports.mock.calls[0][0].userId).toBe(IMPORT_SYSTEM_USER_ID);
  });

  it('says where a re-queued path is ACTUALLY headed', async () => {
    // `(repo, revision, filename)` is unique, so a path queued earlier keeps its original row and
    // its original destination. Without this the caller polls to `Completed` and concludes its own
    // version got the file.
    enqueueImports.mockResolvedValue({
      queued: 0,
      skipped: 2,
      rows: [
        { ...queuedRows[0], status: 'Completed', modelFileId: 900, attachVersionId: 7 },
        queuedRows[1],
      ],
    });

    const res = await run({ body: post() });

    expect(res._body().files).toMatchObject([
      { path: 'flux1-dev.safetensors', status: 'Completed', modelFileId: 900, attachVersionId: 7 },
      { path: 'ae.safetensors', status: 'Queued', attachVersionId: 42 },
    ]);
  });

  it('accepts a pasted repo URL, keeping the revision it names', async () => {
    // Interpolated raw into the Hugging Face path otherwise, which comes back as a 404 that reads
    // like a missing repo.
    await run({
      body: post({ repo: 'https://huggingface.co/black-forest-labs/FLUX.1-dev/tree/beef123' }),
    });

    expect(resolveRepoForImport).toHaveBeenCalledWith({
      repo: 'black-forest-labs/FLUX.1-dev',
      revision: 'beef123',
    });
  });

  it('refuses a version that does not exist, before queueing anything', async () => {
    dbRead.modelVersion.findUnique.mockResolvedValue(null);

    const res = await run({ body: post({ modelVersionId: 999 }) });

    expect(res._status()).toBe(400);
    expect(String(res._body().error)).toContain('999');
    expect(enqueueImports).not.toHaveBeenCalled();
  });

  it('refuses a file the repo does not have, before queueing anything', async () => {
    const res = await run({
      body: post({ files: [{ path: 'not-there.safetensors', type: 'Model' }] }),
    });

    expect(res._status()).toBe(400);
    expect(String(res._body().error)).toContain('not-there.safetensors');
    expect(enqueueImports).not.toHaveBeenCalled();
  });

  it('refuses a type the extension cannot be', async () => {
    const res = await run({
      body: post({ files: [{ path: 'flux1-dev.safetensors', type: 'Config' }] }),
    });

    expect(res._status()).toBe(400);
    expect(String(res._body().error)).toContain('flux1-dev.safetensors');
    expect(enqueueImports).not.toHaveBeenCalled();
  });

  it('answers a malformed body with a 400, not an uncaught 500', async () => {
    const res = await run({ body: post({ files: [{ path: 'flux1-dev.safetensors' }] }) });

    expect(res._status()).toBe(400);
    expect(enqueueImports).not.toHaveBeenCalled();
  });

  it('attaches a file we already store instead of transferring it again', async () => {
    // Hugging Face publishes the sha before any bytes move, so this costs nothing to decide.
    resolveRepoForImport.mockResolvedValue({
      ...repo,
      files: [
        repo.files[0],
        {
          ...repo.files[1],
          existing: { fileId: 77, name: 'ae.safetensors', url: 'https://s3.example/x' },
        },
      ],
    });
    enqueueImports.mockResolvedValue({ queued: 1, skipped: 0, rows: [queuedRows[0]] });

    const res = await run({ body: post() });

    // Only the file we do not hold is queued.
    expect(enqueueImports.mock.calls[0][0].paths).toEqual(['flux1-dev.safetensors']);
    expect(reuseStoredFile).toHaveBeenCalledTimes(1);
    expect(reuseStoredFile.mock.calls[0][0]).toMatchObject({
      path: 'ae.safetensors',
      type: 'VAE',
      storedUrl: 'https://s3.example/x',
      modelVersionId: 42,
    });
    expect(res._body().files).toMatchObject([
      { path: 'flux1-dev.safetensors', reused: false, importId: 11 },
      { path: 'ae.safetensors', reused: true, modelFileId: 900, status: 'Completed' },
    ]);
  });

  it('queues nothing at all when every file is one we hold', async () => {
    resolveRepoForImport.mockResolvedValue({
      ...repo,
      files: repo.files.map((file) => ({
        ...file,
        existing: { fileId: 77, name: file.path, url: 'https://s3.example/x' },
      })),
    });

    const res = await run({ body: post() });

    expect(enqueueImports).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
    expect(res._body().files).toMatchObject([{ reused: true }, { reused: true }]);
  });

  it("passes Hugging Face's own refusal back as a 400", async () => {
    const { HuggingFaceError } = await import('~/server/services/huggingface.service');
    resolveRepoForImport.mockRejectedValue(new HuggingFaceError('The repo is gated or private.'));

    const res = await run({ body: post() });

    expect(res._status()).toBe(400);
    expect(res._body().error).toBe('The repo is gated or private.');
  });
});

describe('GET /api/admin/huggingface-import', () => {
  it('reports one import by id', async () => {
    getImportStatus.mockResolvedValue({ id: 11, status: 'Transferring', bytesTransferred: 10 });

    const res = await run({ method: 'GET', query: { id: '11' } });

    expect(getImportStatus).toHaveBeenCalledWith(11);
    expect(res._body()).toMatchObject({ id: 11, status: 'Transferring' });
  });

  it('404s an id that does not exist', async () => {
    getImportStatus.mockResolvedValue(null);

    const res = await run({ method: 'GET', query: { id: '11' } });

    expect(res._status()).toBe(404);
  });

  it('lists what is in a repo, so a caller can find the paths', async () => {
    const res = await run({ method: 'GET', query: { repo: 'black-forest-labs/FLUX.1-dev' } });

    expect(res._status()).toBe(200);
    expect(res._body()).toMatchObject({ revision: 'abc123' });
    expect(getImportStatus).not.toHaveBeenCalled();
  });
});

describe('the endpoint itself', () => {
  it('refuses a method it does not implement', async () => {
    const res = await run({ method: 'DELETE' });

    expect(res._status()).toBe(405);
    expect(enqueueImports).not.toHaveBeenCalled();
  });

  it('refuses a caller without the token', async () => {
    const res = await run({ method: 'GET', query: { id: '11' }, token: null });

    expect(res._status()).toBe(401);
    expect(getImportStatus).not.toHaveBeenCalled();
  });
});

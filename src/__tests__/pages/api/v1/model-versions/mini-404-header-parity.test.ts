import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

/**
 * Every 404 of `GET /api/v1/model-versions/mini/[id]` is answered, on the wire, exactly as an unknown id: status, body
 * and the whole response header map. The real wrapper (`MixedAuthEndpoint`: Vary, CORS, Cache-Control, X-Expires) and
 * Next's API resolver (Content-Type, Content-Length, ETag) run over a real HTTP socket, for one caller. A header one
 * path adds and another does not would let a client tell a hidden version from a missing one.
 */

const h = vi.hoisted(() => ({
  variant: { value: 'enforce' as string | null },
  session: { value: null as null | { user: Record<string, unknown> } },
  restricted: { value: true },
}));

// Always "not up to date", so the wrapper's X-Expires is on every answer and compared too. Mocked because it reads
// the same `$queryRaw` the route does.
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkNotUpToDate: vi.fn(async () => true),
}));

vi.mock('~/server/auth/api-auth-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiAuthSession: vi.fn(async () => h.session.value),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'mini-epoch-caller-gate' ? h.variant.value : null
  ),
}));
// The caller is in a restricted region, so the region 404 is reachable for the same caller.
vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRegionRestricted: () => h.restricted.value,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntityAccess: vi.fn(async ({ entityIds }: { entityIds: number[] }) =>
    entityIds.map((entityId) => ({ entityId, hasAccess: false }))
  ),
}));
vi.mock('~/server/services/orchestrator/refreshBlobs', () => ({ refreshBlobsService: vi.fn() }));
vi.mock('~/server/services/generation/generation.service', () => ({
  getGateRuleState: vi.fn(async () => ({ known: true, value: [] })),
  getGateSubjects: vi.fn(async () => new Map()),
  gatedVersionIds: vi.fn(() => new Set()),
  resolveCanGenerateForVersions: vi.fn(async () => new Map()),
  getShouldChargeForResources: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));

import handler from '~/pages/api/v1/model-versions/mini/[id]';
import {
  OWNER_ID,
  SERVICE_TOKEN,
  TRAINING_FILE,
  VERSION_ID,
  versionRow,
} from './mini-epoch-fixtures';

const PUBLIC_ROW = { ...versionRow, availability: 'Public', modelAvailability: 'Public' };
const PLAIN_FILE = { ...TRAINING_FILE, visibility: 'Public', metadata: { format: 'SafeTensor' } };

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const id = new URL(req.url ?? '/', 'http://x').pathname.split('/').at(-1);
    const etag = new URL(req.url ?? '/', 'http://x').searchParams.get('etag');
    void apiResolver(
      req,
      res,
      { id, ...(etag ? { etag } : {}) },
      { default: handler },
      {
        previewModeId: 'test',
        previewModeEncryptionKey: 'test',
        previewModeSigningKey: 'test',
        dev: false,
      },
      true
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  // Date and X-Expires are read from the clock; a fixed clock leaves only what the path decides.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
  h.variant.value = 'enforce';
  h.session.value = { user: { id: 9001 } };
  h.restricted.value = true;
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
});

/** One caller (another signed-in user, by bearer, from a restricted region) asks for the version. */
async function wire(versionRows: object[]) {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce(versionRows)
    .mockResolvedValueOnce([structuredClone(PLAIN_FILE)])
    .mockResolvedValue([]);
  const response = await fetch(`${base}/api/v1/model-versions/mini/${VERSION_ID}?etag=1`, {
    headers: { authorization: 'Bearer k', 'cf-ipcountry': 'GB' },
  });
  const headers = Object.fromEntries(
    // Set by Node's HTTP server per connection and second, not by the route.
    [...response.headers.entries()].filter(
      ([name]) => !['connection', 'keep-alive', 'date'].includes(name)
    )
  );
  return { status: response.status, body: await response.text(), headers };
}

describe('mini/[id] every 404 is an unknown id on the wire', () => {
  // `servedWhen`: who IS served this row, so each case proves the row reached the route and the 404 is its own.
  const asOwner = () => (h.session.value = { user: { id: OWNER_ID } });
  const unrestricted = () => (h.restricted.value = false);
  it.each<[string, object, () => void]>([
    ['a person-of-interest model', { ...PUBLIC_ROW, poi: true }, asOwner],
    ['a deleted model', { ...PUBLIC_ROW, modelStatus: 'Deleted' }, asOwner],
    ['an unpublished version', { ...PUBLIC_ROW, status: 'Unpublished' }, asOwner],
    [
      'a Private model the gate withholds',
      { ...PUBLIC_ROW, modelAvailability: 'Private' },
      asOwner,
    ],
    ['a Private version the gate withholds', { ...PUBLIC_ROW, availability: 'Private' }, asOwner],
    ['a level the region is not served', { ...PUBLIC_ROW, nsfwLevel: 16 }, unrestricted],
  ])('%s', async (_shape, row, servedWhen) => {
    const unknown = await wire([]);
    expect(unknown.status).toBe(404);
    expect(unknown.headers).toHaveProperty('x-expires');
    expect(await wire([row])).toEqual(unknown);

    servedWhen();
    expect((await wire([row])).status).toBe(200);
  });
});

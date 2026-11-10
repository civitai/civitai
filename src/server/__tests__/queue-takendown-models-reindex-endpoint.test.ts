import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs the endpoint's real id query against an in-process Postgres: it queues every indexed
 * taken-down model, and no other.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { env, queueModelsReindex } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  queueModelsReindex: vi.fn(async (ids: number[]) => ({ ids: ids.length })),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
// The queueing and its read-back are queue-paid-models-reindex-endpoint.test.ts's to pin.
vi.mock('~/server/search-index/queue-models-reindex', () => ({
  queueModelsReindex,
  queueModelsReindexSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
}));

const handler = (await import('~/pages/api/admin/temp/queue-takendown-models-reindex')).default;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'Deleted');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, status "ModelStatus", availability "Availability" DEFAULT 'Public',
      mode "ModelModifier"
    );
    -- 1 and 2 are indexed and taken down; 3 is taken down but a draft; 4 taken down but
    -- unsearchable; 5 archived; 6 in no mode.
    INSERT INTO "Model" (id, status, availability, mode) VALUES
      (1, 'Published', 'Public', 'TakenDown'),
      (2, 'Published', 'Private', 'TakenDown'),
      (3, 'Draft', 'Public', 'TakenDown'),
      (4, 'Published', 'Unsearchable', 'TakenDown'),
      (5, 'Published', 'Public', 'Archived'),
      (6, 'Published', 'Public', NULL);
  `);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    pgliteRaw(db).queryRaw
  );
});

async function call(query: Record<string, string>) {
  const req = { method: 'POST', query: { token: 'test-token', ...query }, headers: {} } as never;
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  await handler(req, res as never);
  return statusCode;
}

describe('/api/admin/temp/queue-takendown-models-reindex', () => {
  it('queues every indexed taken-down model, and no other', async () => {
    expect(await call({ dryRun: 'false' })).toBe(200);
    const [ids] = queueModelsReindex.mock.calls.at(-1) as unknown as [number[]];
    expect([...ids].sort()).toEqual([1, 2]);
  });
});

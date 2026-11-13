import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { SearchOutboxEntity } from '~/server/search-index/search-outbox-forward';

const h = vi.hoisted(() => ({ queued: [] as { indexName: string; items: unknown[] }[] }));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: {
    queueUpdate: async (args: { indexName: string; items: unknown[] }) => h.queued.push(args),
  },
}));

const { createSearchIndexUpdateProcessor } = await import(
  '~/server/search-index/base.search-index'
);

const SCHEMA = `
  CREATE TYPE "OutboxEntity" AS ENUM ('Article', 'Image', 'Model', 'Post', 'ModelVersion');
  CREATE TABLE "Outbox" (
    id bigserial PRIMARY KEY, event text NOT NULL, "entityType" "OutboxEntity" NOT NULL,
    "entityId" bigint NOT NULL, "createdAt" timestamp(3) DEFAULT now(), details jsonb, attempts int
  );
`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
});
afterAll(() => harness.stop());
beforeEach(async () => {
  h.queued = [];
  // The forward's one write, sent to the real database.
  dbMock.dbWrite.outbox.createMany.mockImplementation((args: never) =>
    harness.prisma.outbox.createMany(args)
  );
  await harness.pg.exec(`TRUNCATE "Outbox";`);
  setEnv({ SEARCH_OUTBOX_FORWARD: ['Article', 'Comic'] });
});

const processor = (outboxEntity: SearchOutboxEntity, retired = false) =>
  createSearchIndexUpdateProcessor({
    indexName: `test_${outboxEntity}`,
    outboxEntity,
    retired,
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: 1, startId: 0, endId: 0 }),
    pullData: async () => [],
    transformData: async (x) => x,
    pushData: async () => undefined,
  });

const outbox = () =>
  harness.pg
    .query<{ event: string; entityType: string; entityId: string; details: unknown }>(
      `SELECT event, "entityType", "entityId"::text, details FROM "Outbox" ORDER BY id`
    )
    .then((r) => r.rows);

describe('the search Outbox forward', () => {
  it('still forwards when the Meilisearch index is retired', async () => {
    await processor('Article', true).queueUpdate(
      [{ id: 1 }, { id: 2, action: SearchIndexUpdateQueueAction.Delete }],
      { reason: 'edit' }
    );
    expect(await outbox()).toEqual([
      {
        event: 'search.update',
        entityType: 'Article',
        entityId: '1',
        details: { reason: 'edit', action: 'Update' },
      },
      {
        event: 'search.update',
        entityType: 'Article',
        entityId: '2',
        details: { reason: 'edit', action: 'Delete' },
      },
    ]);
    expect(h.queued).toEqual([]);
  });

  it('never forwards a metrics update, but still queues it for Meilisearch', async () => {
    await processor('Article').queueUpdate([{ id: 1 }], { reason: 'metrics' });
    expect(await outbox()).toEqual([]);
    expect(h.queued).toHaveLength(1);
  });

  it('forwards nothing for an entity the flag leaves out', async () => {
    setEnv({ SEARCH_OUTBOX_FORWARD: [] });
    await processor('Article').queueUpdate([{ id: 1 }], { reason: 'edit' });
    expect(await outbox()).toEqual([]);
    expect(h.queued).toHaveLength(1);
  });

  // A stubbed rejection, not a real database error: the socket harness can report a SQL error as a
  // dropped connection instead, which made the message nondeterministic.
  it('swallows a failed insert, and still queues the update for Meilisearch', async () => {
    loggingMock.logToAxiom.mockClear();
    dbMock.dbWrite.outbox.createMany.mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      processor('Comic').queueUpdate([{ id: 1 }], { reason: 'edit' })
    ).resolves.toBeUndefined();

    expect(h.queued).toHaveLength(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'search-outbox-forward', message: 'insert failed' })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SearchIndex from '~/server/search-index';

// The moderator app syncs every image it moderates through this endpoint
// (apps/moderator/src/lib/server/search-index.ts).

const { metricsQueue } = vi.hoisted(() => ({ metricsQueue: vi.fn() }));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  imagesMetricsSearchIndex: { queueUpdate: metricsQueue },
}));

const handler = (await import('~/pages/api/internal/search-index-update')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

function call(body: unknown) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return handler(
    { method: 'POST', body } as NextApiRequest,
    res as unknown as NextApiResponse
  ).then(() => res);
}

describe('search-index-update', () => {
  beforeEach(() => {
    metricsQueue.mockReset();
    // The collections leg first checks for its cover index; with none it throws and the requeue retries.
    dbMock.dbWrite.$queryRaw
      .mockReset()
      .mockImplementation((async (sql: TemplateStringsArray) =>
        sql.join('?').includes('pg_index') ? [{ present: true }] : []) as never);
  });

  /** The image -> model lookup that opens every blocked-image requeue, by the ids it read. */
  const documentLookups = () =>
    dbMock.dbWrite.$queryRaw.mock.calls
      .filter(([strings]) =>
        (strings as TemplateStringsArray)
          .join('?')
          .includes('SELECT p."modelVersionId", mv."modelId"')
      )
      .map(([, ...values]) => values);

  it("syncs a moderated image's metrics index", async () => {
    const res = await call({ entityType: 'image', entityId: 42, action: 'delete' });
    expect(res.statusCode).toBe(200);
    expect(metricsQueue).toHaveBeenCalledTimes(1);
    expect(metricsQueue.mock.calls[0][0]).toEqual([{ id: 42, action: 'Delete' }]);
  });

  it('queues the documents showing an image the moderator app removed', async () => {
    const res = await call({ entityType: 'image', entityIds: [42, 43], action: 'delete' });
    expect(res.statusCode).toBe(200);
    expect(documentLookups()).toEqual([
      [
        [42, 43],
        [42, 43],
      ],
    ]);
  });

  // The moderator app's block reads the response; a failed requeue must not turn it into an error.
  it('answers only after the requeue, and still answers ok when the requeue fails', async () => {
    vi.useFakeTimers();
    try {
      dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('db down') as never);
      let settled = false;
      const pending = call({ entityType: 'image', entityId: 42, action: 'delete' }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // waiting out the retry delay
      await vi.advanceTimersByTimeAsync(1000);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
      expect(documentLookups()).toEqual([
        [[42], [42]],
        [[42], [42]],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the documents of an image it only updates, as on a restore (control)', async () => {
    await call({ entityType: 'image', entityId: 42, action: 'update' });
    expect(metricsQueue).toHaveBeenCalledTimes(1);
    expect(documentLookups()).toEqual([]);
  });

  it('leaves image documents alone when another entity is deleted (control)', async () => {
    await call({ entityType: 'model', entityId: 42, action: 'delete' });
    expect(documentLookups()).toEqual([]);
  });

  it('still refuses an entity type it has no index for', async () => {
    const res = await call({ entityType: 'nope', entityId: 42 });
    expect(res.statusCode).toBe(400);
    expect(metricsQueue).not.toHaveBeenCalled();
  });
});

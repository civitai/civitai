import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowRange, MONGO_BATCH_SIZE, MONGO_MAX_TIME_MS } from '../sources/mongo';

/**
 * The export's other tests pass a fake collection, so nothing else would notice the real `mongodb`
 * driver changing under `mongo-client.ts`. This one loads the real driver (only `connect` is
 * stubbed, so no socket and no SRV lookup) and checks the contract the export depends on: the
 * client options, and that `find` with the export's exact options yields a real, closable cursor.
 * It asserts behaviour, never the driver version, so it holds on 6.x and 7.x alike.
 */

async function load() {
  // mongo-client caches its client at module scope; a fresh module per case keeps URL cases apart.
  vi.resetModules();
  const { MongoClient } = await import('mongodb');
  const connect = vi.spyOn(MongoClient.prototype, 'connect').mockResolvedValue(undefined as never);
  const { getWorkflowCollection } = await import('../mongo-client');
  return { MongoClient, connect, getWorkflowCollection };
}

const FIND_OPTIONS = {
  sort: { _id: 1 },
  hint: '_id_',
  batchSize: MONGO_BATCH_SIZE,
  maxTimeMS: MONGO_MAX_TIME_MS,
  limit: 50,
} as const;

type MongoClientLike = {
  options: {
    readPreference: { mode: string };
    retryWrites: boolean;
    srvHost?: string;
    hosts: { host: string }[];
  };
};

afterEach(() => vi.restoreAllMocks());

describe('personal-data-export mongo-client against the real driver', () => {
  it('reads from a secondary with retryWrites off, and parses a mongodb+srv URL', async () => {
    const { connect, getWorkflowCollection } = await load();

    await getWorkflowCollection('mongodb+srv://reader:pw@cluster0.example.net/prod');

    expect(connect).toHaveBeenCalledTimes(1);
    const created = connect.mock.contexts[0] as MongoClientLike;
    expect(created.options.readPreference.mode).toBe('secondary');
    expect(created.options.retryWrites).toBe(false);
    expect(created.options.srvHost).toBe('cluster0.example.net');
  });

  it('a plain mongodb:// URL gets its own client with the same options', async () => {
    const { connect, getWorkflowCollection } = await load();

    await getWorkflowCollection('mongodb://reader:pw@db1.example.net:27017,db2.example.net/prod');

    const created = connect.mock.contexts[0] as MongoClientLike;
    expect(created.options.srvHost).toBeUndefined();
    expect(created.options.hosts.map((h) => h.host)).toEqual([
      'db1.example.net',
      'db2.example.net',
    ]);
    expect(created.options.readPreference.mode).toBe('secondary');
  });

  it('find() with the export options returns a real closable async-iterable cursor', async () => {
    const { getWorkflowCollection } = await load();
    const collection = await getWorkflowCollection('mongodb://reader:pw@db1.example.net/prod');

    const cursor = collection.find(workflowRange(7), { ...FIND_OPTIONS });

    // The driver's own cursor, not a stand-in. `findOptions` is internal to the driver (no public
    // getter exposes limit/hint/sort): if a driver bump renames it, update this read, don't drop it.
    const real = cursor as unknown as {
      readPreference: { mode: string };
      findOptions: {
        sort: Map<string, number>;
        hint: string;
        batchSize: number;
        maxTimeMS: number;
        limit: number;
      };
    };
    expect(typeof cursor[Symbol.asyncIterator]).toBe('function');
    expect(typeof cursor.close).toBe('function');
    expect(real.readPreference.mode).toBe('secondary');
    expect(real.findOptions.hint).toBe('_id_');
    expect(real.findOptions.batchSize).toBe(MONGO_BATCH_SIZE);
    expect(real.findOptions.maxTimeMS).toBe(MONGO_MAX_TIME_MS);
    expect(real.findOptions.limit).toBe(50);
    expect([...real.findOptions.sort]).toEqual([['_id', 1]]);
    await cursor.close();
  });
});

import { MongoClient } from 'mongodb';
import { MONGO_COLLECTION, MONGO_DATABASE, type WorkflowCollection } from './sources/mongo';

let client: MongoClient | undefined;

/**
 * The stored workflows collection, read from a secondary only (never the primary) over a read-only
 * user. Only `find` is exposed to the export.
 */
export async function getWorkflowCollection(url: string): Promise<WorkflowCollection> {
  client ??= new MongoClient(url, { readPreference: 'secondary', retryWrites: false });
  await client.connect();
  const collection = client.db(MONGO_DATABASE).collection(MONGO_COLLECTION);
  return {
    find: (filter, options) =>
      collection.find(filter as never, options) as unknown as ReturnType<
        WorkflowCollection['find']
      >,
  };
}

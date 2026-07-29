
## Caches
- A createCache factory similar to docs\reference\feeds\cache-helper.md

**Factory**: `src/common/caches/base.ts
```ts
// Use a new factory that's similar to docs\reference\feeds\cache-helper.md
type CacheContext = {
  pg: {
    query: <T=any>(query: string, params?: T[]) => Promise<T[]>
  },
  ch: {
    query: <T=any>(query: string, params?: T[]) => Promise<T[]>
  },
  redis: IRedis // Upgraded to msgPackr IRedis instance
}

type CacheConfig = {
  redisKey: string, // The prefix for the cached items
  idKey: string, // The prop that will be used as the key in the resulting cache Map/object
  fetch: (ctx: CacheContext, ids: number[]) => Promise<T extends Record<string, any>[]>,
  append?
  //... @justin: please determine the other items that would need to be here based on the cache-helper.md
}
```

**Example Cache File**: `src/common/caches/userData.cache.ts`
```ts
export const userData = createCache({
  key: 'userId',
  async fetch({ pg, ch, redis }: CacheContext, ids: number[]) {
    // how to fetch this data on cache miss
    // getting distributed lock

    return {
      userId: 1,
      username: 'justmaier'
      //... Other cached user data
    }
  },
  ttl: 60*60*24
})
```
- the fetch function should have a type T driven by the return type of the fetch fn

**Cache Barrel**: `src/common/caches/index.ts
```ts
export { userData } from './userData.ts'
export { modelData } from './modelData.ts'
//...
```
So that we can just do `import * as caches from 'src/common/caches'` and then grab them by name.

**Cache Service**: `src/common/services/cache.ts`
```ts
import * as caches from 'src/common/caches'

interface IDataPacker = {
  pack: (value: any) => Buffer
  unpack: (packed: Buffer | Uint8Array) => any;
}

export class CacheService {
  private context: CacheContext;
  constructor(redis: IRedisClient, pg: IDbClient, ch: IClickhouseClient, packer?: IDataPacker){
    // run the helper that makes the redis client use msgPackr
    this.context: CacheContext = {
      pg: {
        query(query: string, params?: any[]) {
          // use pg to do query...
        }
      },
      // ... other context stuff
      redis: packer ? withRedisPacking(redis, packer) : redis
    }
  }
  fetch(name: keyof typeof caches, ids: number[]): Promise<Result<caches[name]>> {
    // Should have a typed result based on the cache you're fetching by name so if you used name='userData' the result should match the result type of the userData.fetch fn

    const cache = caches[name];
    if (!cache) throw new Error(`Cache named '${name}' could not be found`);

    return cache.fetch(this.context, ids);
  }
}
```

## Meilisearch
Currently the `common` submodule has a dependency on `meilisearch` but I'd like to replace that with an interface that covers the things that we'll need specifically for feeds so that we can remove that dependency.
```ts
interface IMeilisearch {
  // @justin: Help me create this spec.
}

// @justin: Here's how it's being used
const client = new MeiliSearch({
  host: env.METRICS_SEARCH_HOST as string,
  apiKey: env.METRICS_SEARCH_API_KEY,
})



const getOrCreateIndex = async (
  indexName: string,
  options?: IndexOptions,
  client: MeiliSearch | null = client
) => {
  try {
    console.log('getOrCreateIndex :: Getting index :: ', indexName);
    // Will swap if index is created.
    // console.log(client);
    const index = await client.getIndex(indexName);

    if (options) {
      await index.update(options);
    }

    return index;
  } catch (e) {
    const meiliSearchError = e as MeiliSearchErrorInfo;

    if (meiliSearchError.code === 'index_not_found') {
      console.error('getOrCreateIndex :: Error :: Index not found. Attempting to create it...');
      const createdIndexTask = await client.createIndex(indexName, options);
      await client.waitForTask(createdIndexTask.taskUid);
      return await client.getIndex(indexName);
    } else {
      console.error('getOrCreateIndex :: Error :: ', e);
    }

    // Don't handle it within this scope
    throw e;
  }
};

const index = getOrCreateIndex('indexName', { primaryKey: 'id' });
type Settings = { // This is just some of what Meilisearch returns, but it's all we need.
  filterableAttributes?: FilterableAttributes
  sortableAttributes?: SortableAttributes
  searchableAttributes?: SearchableAttributes
  displayedAttributes?: DisplayedAttributes
  rankingRules?: RankingRules
}
const settings = await index.getSettings(); // => Settings

// await index.updateSearchableAttributes(attributes: string[]) => Task: any // We don't need to access anything here so it doesn't matter, but Meilisearch does care about it for things like `client.waitForTask(task)` so we should have a type for it.
// await index.updateSortableAttributes(attributes: string[]) => Task
// await index.updateFilterableAttributes(attributes: string[]) => Task
// await index.updateRankingRules(attributes: string[]) => Task
// await index.updateDocuments(documents: Array<Partial<T>>) => Task
// await index.deleteDocuments(ids: number[]) => Task

type SearchOptions = {
  filters: string
  sorts: string[]
  limit: number
  offset: number
}
const results = await index.search<T>(null, searchOptions);
const hits = results.hits; // T[] - This is the only prop we care about in the return of this fn.
```

So with those things in mind as how the IMeilisearch interface will be used we should expose these helpers:
```ts
// @justin: And we'll probably want a way to create the client and get the index all at once
async function getMeilisearchFeed(client: IMeilisearch, config: {
  host: string,
  apiKey: string,
  name: string
}){
  const { host, apiKey, name } = config;
  const client = IMeilisearch({
    host,
    apiKey
  });

  // place the logic that corresponds with getOrCreateIndex(name, { primaryKey: 'id' }, client)
  // return the index object
}
```

## Utils
This is so we can handle batching document inserts to meilisearch:
```ts
function createAsyncBatcher<T>(
  batchSize: number,
  flushFn: (items: T[]) => Promise<void>
) {
  const buffer: T[] = [];
  let chain = Promise.resolve();

  async function doFlush() {
    if (buffer.length === 0) return;
    const toFlush = buffer.splice(0, buffer.length);
    await flushFn(toFlush).catch(console.error);
  }

  const enqueue = (items: T[]) => {
    chain = chain
      .then(async () => {
        buffer.push(...items);
        if (buffer.length >= batchSize) {
          await doFlush();
        }
      })
      .catch(console.error);
  };

  const flush = async () => {
    await chain; // waits for all enqueued flushes
    await doFlush(); // flush anything remaining
  };

  return { enqueue, flush };
}


/**
 * Runs async tasks with limited concurrency.
 * Each task is a function returning a Promise.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < tasks.length) {
      const i = currentIndex++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        console.error(`Task ${i} failed:`, err);
        // Optional: rethrow if you want failure to stop execution
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
    worker()
  );

  await Promise.all(workers);
  return results;
}
```

## Feeds
Infra... These probably should be in something like `src/common/feeds/types.ts` and `src/common/feeds/base.ts` or maybe together in base...
```ts
import { EntityType, EntityMetricMap } from '@common/types/metric-types';

type FeedContext<E extends EntityType> = {
  pg: {
    query: <T=any>(query: string, params?: T[]) => Promise<T[]>
  },
  ch: {
    query: <T=any>(query: string, params?: T[]) => Promise<T[]>
  },
  cache: {
    fetch: (name: keyof typeof caches, ids: number[]) => Promise<Result<caches[name]>> // Should have a typed result based on the cache you're fetching by name so if you used name='userData' the result should match the result type of the userData.fetch fn
  }
  metric: {
    fetch: (ids: number[]) => Promise<Record<number, EntityMetricMap[E]>>
  },
  index: {
    search: (options: SearchOptions) => index.search<InferFromSchema>
    // This should basically just make it easier to use the index.search fn with the type that we already know we'll be getting from the index based on the config.
  }
}

type FeedQueryInput<T extends Record<string, any>> = {
  limit?: number,
  cursor?: string, // '{sortAt}:{id}' - Flexible so that we can handle multipart cursors as needed
} & T;

type FeedAdvancedOptions = {
  fetchBatchSize: number // default 1000
  upsertBatchSize: number // default 100k
  createConcurrency: number // default 2
}

type UpsertType = 'full' | 'metrics';

type CreateFeedConfig<T extends EntityType, TInput extends Record<string, any>> = {
  name: string,
  connection: {
    host: string, // https:image-feed.civitai.com/meilisearch
    apiKey: string
  },
  schema: Record<string, { type: 'string' | 'number' | 'Date' | 'boolean' | 'array', arrayType?: 'string' | 'number' | 'boolean', sortable?: boolean, filterable?: boolean, primary?: boolean }>,
  createDocuments: (ctx: FeedContext<T>, ids: number[], type: UpsertType = 'full') => Promise<InferFromSchema[]>, // Will be broken into batches above this so we don't need to worry about batching here - Documents should be as flat as possible
  queryDocuments: (ctx: FeedContext<T>, input: FeedQueryInput<TInput>) => Promise<InferFromSchema[]>, // Get raw results from feed
  populateDocuments: (ctx: FeedContext<T>, documents: InferFromSchema[]) => Promise<T extends Record<string, any>[]>, // returns a fully populated document for api/ui rendering - uses db and caches to populate
  options?: FeedAdvancedOptions
}

function createFeed<T extends EntityType>(config: CreateFeedConfig<T>) {
  const options: AdvancedFeedOptions = {
    feedBatchSize: 1000,
    upsertBatchSize: 100000,
    createConcurrency: 2,
    ...(config.options ?? {})
  }

  class Feed {
    private client: IMeilisearch;
    private context: FeedContext;
    private index: IMeilisearch.index;
    private indexError: Error | undefined;
    private indexReady: Promise<boolean>;
    constructor(ch: IClickhouseClient, pg: IDbclient, metricService: MetricService, cacheService: CacheService, Meilisearch: IMeilisearch){
      this.client = new Meilisearch({
        host: config.connection.host,
        apiKey: config.connection.apiKey,
      })
      this.indexReady = getMeilisearchFeed({
        client: this.client, // @justin: Let's change this to taking a client
        name: config.name
      }).then((index) => {
        this.index = index
        return true;
      }).catch((err) => {
        this.indexError = err as Error;
        console.error(err);
        return false;
      })
      this.context = {
        // build context using services
      }
    }

    private async function ready() {
      if (!await this.indexReady) throw new Error(this.indexError)
    }

    async function delete(ids: number[]){
      await this.ready();
      const task = await this.index.deleteDocuments(ids);
    }

    async function upsert(ids: number[], type: UpsertType = 'full') {
      await this.ready();

      const batcher = createAsyncBatcher(
        options.upsertBatchSize,
        async (docs) => this.index.updateDocuments(docs)
      );

      const batches = chunk(ids, options.batchSize);

      const tasks = batches.map((batch) => async () => {
        const docs = await config.createDocuments(this.context, batch, type);
        batcher.enqueue(docs);
      });

      await runWithConcurrency(tasks, options.createConcurrency);
      await batcher.flush(); // ensure leftovers get processed
    }

    // @justin: Not sure the right way to get the type for input
    async function query(input: typeof config.queryDocuments['input']) {
      const docs = await config.queryDocuments(this.ctx, input);
      return docs;
    }

    // @justin: I know this type isn't quite right either...
    async function populate(docs: InferFromSchema[]) {
      const populatedDocs = await config.populateDocuments(this.ctx, docs);
      return populatedDocs;
    }

    async function populatedQuery(input: typeof config.queryDocuments['input']) {
      return await this.populate(await this.query(input));
    }

  }



  return Feed;
}
```

**Individual feeds**: Then individual feeds would be created `src/common/feeds/image.feed.ts`
```ts
export const imageFeed = createFeed({
  //... Image feed config
})
```

And barreled into: `src/common/feed/index.ts`
```ts
export { imageFeed } from './image.feed'
export { modelFeed } from './image.feed'
//... Other feeds
```

So that in this project we could easily initialize all of them and call the corresponding methods from `src\services\index-update-queue.ts`

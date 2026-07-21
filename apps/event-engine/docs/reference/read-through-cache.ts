type CachedLookupOptions<T extends object> = {
    key: RedisKeyTemplateCache;
    idKey: keyof T;
    lookupFn: (ids: number[], fromWrite?: boolean) => Promise<Record<string, T>>;
    appendFn?: (results: Set<T>) => Promise<void>;
    ttl?: number;
    debounceTime?: number;
    cacheNotFound?: boolean;
    dontCacheFn?: (data: T) => boolean;
    staleWhileRevalidate?: boolean;
  };
  export function createCachedArray<T extends object>({
    key,
    idKey,
    lookupFn,
    appendFn,
    ttl = CacheTTL.xs,
    debounceTime = 10,
    cacheNotFound = true,
    dontCacheFn,
    staleWhileRevalidate = true,
  }: CachedLookupOptions<T>) {
    async function fetch(ids: number[]) {
      if (!ids.length) return [] as T[];
      const results = new Set<T>();
      const cacheResults: T[] = [];
      for (const batch of chunk(ids, 200)) {
        const batchResults = await redis.packed.mGet<T>(
          batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache)
        );
        cacheResults.push(...batchResults.filter(isDefined));
      }
      const cacheArray = cacheResults.filter((x) => x !== null) as T[];
      const cache = Object.fromEntries(cacheArray.map((x) => [x[idKey], x]));

      const cacheDebounceCutoff = new Date(Date.now() - debounceTime * 1000);
      const cacheMisses = new Set<number>();
      const dontCache = new Set<number>();
      const toRevalidate: Record<number, T> = {};
      const ttlExpiry = new Date(Date.now() - ttl * 1000);
      const locks = new Set<RedisKeyTemplateCache>();
      for (const id of [...new Set(ids)]) {
        const cached = cache[id];
        if (cached) {
          if (cached.notFound) continue;
          if (cached.debounce) {
            if (cached.cachedAt > cacheDebounceCutoff) dontCache.add(id);
            cacheMisses.add(id);
            continue;
          }
          if (staleWhileRevalidate && cached.cachedAt < ttlExpiry) {
            toRevalidate[id] = cached;
            continue;
          }
          results.add(cached);
        } else cacheMisses.add(id);
      }

      const toRevalidateIds = Object.keys(toRevalidate).map(Number);
      if (toRevalidateIds.length > 0) {
        const gotLocks = await Promise.all(
          toRevalidateIds.map((id) =>
            redis.setNxKeepTtlWithEx(`${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}`, '1', 10)
          )
        );
        for (let i = 0; i < toRevalidateIds.length; i++) {
          const id = toRevalidateIds[i];
          if (!gotLocks[i]) {
            results.add(toRevalidate[id]);
            continue;
          }
          cacheMisses.add(id);
          locks.add(`${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}`);
        }
      }

      if (dontCache.size > 0)
        log(`${key}: Cache debounce - ${dontCache.size} items: ${[...dontCache].join(', ')}`);

      // If we have cache misses, we need to fetch from the DB
      if (cacheMisses.size > 0) {
        log(`${key}: Cache miss - ${cacheMisses.size} items: ${[...cacheMisses].join(', ')}`);
        const dbResults: Record<string, T> = {};
        const lookupBatches = chunk([...cacheMisses], 10000);
        for (const batch of lookupBatches) {
          const batchResults = await lookupFn([...batch] as typeof ids);
          Object.assign(dbResults, batchResults);
        }

        const toCache: Record<string, MixedObject> = {};
        const toCacheNotFound: Record<string, MixedObject> = {};
        const cachedAt = new Date();
        for (const id of cacheMisses) {
          const result = dbResults[id];
          if (!result) {
            if (cacheNotFound) toCacheNotFound[id] = { [idKey]: id, notFound: true, cachedAt };
            continue;
          }
          results.add(result as T);
          if (!dontCache.has(id) && !dontCacheFn?.(result)) toCache[id] = { ...result, cachedAt };
        }

        // then cache the results
        const EX = staleWhileRevalidate ? ttl * 2 : ttl;
        if (Object.keys(toCache).length > 0)
          await Promise.all(
            Object.entries(toCache).map(([id, cache]) =>
              redis.packed.set(`${key}:${id}`, cache, { EX })
            )
          );

        // Use NX to avoid overwriting a value with a not found...
        if (Object.keys(toCacheNotFound).length > 0)
          await Promise.all(
            Object.entries(toCacheNotFound).map(([id, cache]) =>
              redis.packed.set(`${key}:${id}`, cache, { EX, NX: true })
            )
          );
      }

      // Remove locks
      if (locks.size > 0) await redis.del([...locks]);

      if (appendFn) await appendFn(results);

      return [...results].map((x) => {
        // Remove cachedAt from result since this is an internal value
        if ('cachedAt' in x) delete x.cachedAt;
        return x;
      });
    }

    async function bust(id: number | number[], options: { debounceTime?: number } = {}) {
      const ids = Array.isArray(id) ? id : [id];
      if (ids.length === 0) return;

      await Promise.all(
        ids.map((id) =>
          redis.packed.set(
            `${key}:${id}`,
            { [idKey]: id, debounce: true },
            {
              EX: options.debounceTime ?? debounceTime,
            }
          )
        )
      );
      log(`Busted ${ids.length} ${key} items: ${ids.join(', ')}`);
    }

    async function invalidate(id: number | number[], options: { debounceTime?: number } = {}) {
      const ids = Array.isArray(id) ? id : [id];
      if (ids.length === 0) return;

      const cacheResults: T[] = [];
      for (const batch of chunk(ids, 200)) {
        const batchResults = await redis.packed.mGet<T>(
          batch.map((id) => `${key}:${id}` as RedisKeyTemplateCache)
        );
        cacheResults.push(...batchResults.filter(isDefined));
      }

      // Invalidate cache
      const invaliDate = new Date(
        Date.now() - ttl * 1000 + (options.debounceTime ?? debounceTime) * 1000
      );
      const updates = cacheResults.filter(
        (x) => x !== null && 'cachedAt' in x && x.cachedAt !== invaliDate
      ) as T[];
      if (updates.length === 0) return;
      const toCache = Object.fromEntries(
        updates.map((x) => [x[idKey], { ...x, cachedAt: invaliDate }])
      );
      const EX = ttl * 2;
      if (Object.keys(toCache).length > 0)
        await Promise.all(
          Object.entries(toCache).map(([id, cache]) =>
            redis.packed.set(`${key}:${id}`, cache, { EX })
          )
        );

      log(`Invalidated ${ids.length} ${key} items: ${ids.join(', ')}`);
    }

    async function refresh(id: number | number[]) {
      if (!Array.isArray(id)) id = [id];

      const results = await lookupFn(id, true);
      const cachedAt = new Date();
      await Promise.all(
        Object.entries(results).map(
          ([id, x]) => redis.packed.set(`${key}:${id}`, { ...x, cachedAt }),
          {
            EX: ttl,
          }
        )
      );

      const toRemove = id.filter((x) => !results[x]).map(String);
      await Promise.all(toRemove.map((id) => redis.del(`${key}:${id}`)));
    }

    return { fetch, bust: staleWhileRevalidate ? invalidate : bust, refresh };
  }
  export type CachedArray<T extends object> = ReturnType<typeof createCachedArray<T>>;

  export function createCachedObject<T extends object>(lookupOptions: CachedLookupOptions<T>) {
    const cachedArray = createCachedArray<T>(lookupOptions);

    async function fetch(ids: number | number[]) {
      if (!Array.isArray(ids)) ids = [ids];
      const results = await cachedArray.fetch(ids);
      return Object.fromEntries(
        results.map((x) => [(x[lookupOptions.idKey] as number | string).toString(), x])
      ) as Record<string, T>;
    }

    return { ...cachedArray, fetch };
  }
  export type CachedObject<T extends object> = ReturnType<typeof createCachedObject<T>>;
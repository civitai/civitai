### 1. Simple `getHashCode` for strings

Classic Java-style hash:

```ts
function getHashCode(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0 // force 32-bit int
  }
  return hash
}
```

---

### 2. Use for `(sql, params)` key

```ts
function makeKey(sql: string, params: any[]): string {
  const input = sql + JSON.stringify(params)
  return getHashCode(input).toString(36) // shorter string
}
```

---

### 3. Drop into the LRU wrapper

```ts
import LRU from 'lru-cache'

function makeMemoizedQuery<T>(
  queryFn: (sql: string, params: any[]) => Promise<T>,
  options: LRU.Options<string, T> = {}
) {
  const cache = new LRU<string, T>({
    max: 1000,
    ttl: 60_000,
    ...options,
  })

  return async (sql: string, params: any[]): Promise<T> => {
    const key = makeKey(sql, params)

    if (cache.has(key)) return cache.get(key)!

    const result = await queryFn(sql, params)
    cache.set(key, result)
    return result
  }
}
```
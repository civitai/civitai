import { LRUCache } from 'lru-cache';
import { isCommitSha } from '~/server/services/blocks/app-source-repo.plan';

/**
 * Process-local cache for source-repo reads addressed by an object id: a tree at a COMMIT id, a
 * blob by its blob id. Both are immutable for a given id, so an entry is never stale and needs no
 * invalidation; the cache is bounded by size only. A ref that is not a full object id (a branch
 * name) is never cached: what it names moves.
 */

const MAX_BYTES = 64 * 1024 * 1024;

type Entry = Map<string, string> | Buffer;

const sizeOf = (value: Entry): number => {
  if (Buffer.isBuffer(value)) return Math.max(1, value.byteLength);
  let n = 1;
  for (const [path, sha] of value) n += path.length + sha.length;
  return n;
};

const cache = new LRUCache<string, Entry>({
  maxSize: MAX_BYTES,
  sizeCalculation: sizeOf,
  // A single entry larger than this is read but not kept.
  maxEntrySize: MAX_BYTES / 4,
});

async function cached<V extends Entry>(
  key: string,
  id: string,
  read: () => Promise<V>
): Promise<V> {
  // A blob id has a commit id's shape (SHA-1 or SHA-256 hex).
  if (!isCommitSha(id)) return read();
  const hit = cache.get(key) as V | undefined;
  if (hit !== undefined) return hit;
  // Only a read that succeeded is kept: a failure is retried by the next caller.
  const value = await read();
  cache.set(key, value);
  return value;
}

/**
 * `read(repo, commitSha)` (path → blob id), cached by `org` (the git host org `read` reads from),
 * `repo` and commit id. Each caller gets its own copy of the map.
 */
export function commitIdCachedTree(
  org: string,
  read: (repo: string, commitSha: string) => Promise<Map<string, string>>
) {
  return async (repo: string, commitSha: string): Promise<Map<string, string>> =>
    new Map(
      await cached(`tree:${org}/${repo}@${commitSha}`, commitSha, () => read(repo, commitSha))
    );
}

/**
 * `read(repo, blobSha)`, cached by `org`, `repo` and blob id. Callers must not write into the
 * buffer.
 */
export function commitIdCachedBlob(
  org: string,
  read: (repo: string, blobSha: string) => Promise<Buffer>
) {
  return (repo: string, blobSha: string): Promise<Buffer> =>
    cached(`blob:${org}/${repo}@${blobSha}`, blobSha, () => read(repo, blobSha));
}

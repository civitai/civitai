import { describe, expect, it, vi } from 'vitest';
import { commitIdCachedBlob, commitIdCachedTree } from '~/server/services/blocks/commit-id-reads';

const COMMIT = '1'.repeat(40);
const OTHER = '2'.repeat(40);

// The cache is per process: each case reads its own repo name so no case sees another's entries.
describe('commit-id cached reads', () => {
  it('reads a tree at a commit id once, and hands each caller its own copy', async () => {
    const read = vi.fn(async (_repo: string, sha: string) => new Map([['a.ts', `blob-${sha}`]]));
    const tree = commitIdCachedTree('org', read);
    const first = await tree('repo-tree', COMMIT);
    first.set('injected', 'x');
    expect(await tree('repo-tree', COMMIT)).toEqual(new Map([['a.ts', `blob-${COMMIT}`]]));
    expect(read).toHaveBeenCalledTimes(1);
    // Another commit, another repo and another org are other entries.
    await tree('repo-tree', OTHER);
    await tree('repo-tree-2', COMMIT);
    await commitIdCachedTree('org-2', read)('repo-tree', COMMIT);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('never caches a ref that is not a full object id (a branch moves)', async () => {
    const read = vi.fn(async () => new Map<string, string>());
    const tree = commitIdCachedTree('org', read);
    await tree('repo-branch', 'main');
    await tree('repo-branch', 'main');
    await tree('repo-branch', COMMIT.slice(0, 12));
    await tree('repo-branch', COMMIT.slice(0, 12));
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('keeps no failed read: the next caller reads again', async () => {
    const read = vi
      .fn<(repo: string, sha: string) => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error('git host down'))
      .mockResolvedValue(Buffer.from('content'));
    const blob = commitIdCachedBlob('org', read);
    await expect(blob('repo-fail', COMMIT)).rejects.toThrow('git host down');
    expect((await blob('repo-fail', COMMIT)).toString()).toBe('content');
    expect((await blob('repo-fail', COMMIT)).toString()).toBe('content');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

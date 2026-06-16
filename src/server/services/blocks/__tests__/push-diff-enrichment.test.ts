import { beforeEach, describe, expect, it, vi } from 'vitest';

// computePushDiffSummaries reconstructs the bundle from Forgejo
// (listRepoTreeAtRef + getBlobContent) and reads the previous approved version
// via dbRead — mock both so the test drives the real reconstruct → extract →
// diff pipeline end-to-end without a live Forgejo / DB.
vi.mock('../forgejo.service', () => ({
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlockPublishRequest: { findFirst: vi.fn() } },
  dbWrite: {},
}));

import { computePushDiffSummaries } from '../publish-request.service';
import { getBlobContent, listRepoTreeAtRef } from '../forgejo.service';
import { dbRead } from '~/server/db/client';

const manifestV2 = {
  blockId: 'demo',
  version: '0.2.0',
  name: 'Demo',
  contentRating: 'g',
};

// Forgejo tree: path -> blob sha. Contents resolved via getBlobContent(blobSha).
function mockForgejoRepo(files: Record<string, string>) {
  const tree = new Map(Object.keys(files).map((p) => [p, `blob-${p}`]));
  vi.mocked(listRepoTreeAtRef).mockResolvedValue(tree as never);
  vi.mocked(getBlobContent).mockImplementation(async (_slug: string, blobSha: string) => {
    const path = blobSha.replace(/^blob-/, '');
    return Buffer.from(files[path], 'utf8') as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computePushDiffSummaries', () => {
  it('labels a first-version push (no previous approved version)', async () => {
    mockForgejoRepo({
      'block.manifest.json': JSON.stringify(manifestV2),
      'index.html': '<h1>v2</h1>',
    });
    vi.mocked(dbRead.appBlockPublishRequest.findFirst).mockResolvedValue(null as never);

    const { fileSummary, manifestDiffSummary } = await computePushDiffSummaries('demo', 'sha2');

    expect(manifestDiffSummary.kind).toBe('first-version');
    expect(fileSummary.added.sort()).toEqual(['block.manifest.json', 'index.html']);
    expect(fileSummary.removed).toEqual([]);
    expect(fileSummary.changed).toEqual([]);
    // The reconstruct pinned the exact pushed ref.
    expect(vi.mocked(listRepoTreeAtRef)).toHaveBeenCalledWith('demo', 'sha2');
  });

  it('diffs against the previous approved version (update)', async () => {
    mockForgejoRepo({
      'block.manifest.json': JSON.stringify(manifestV2),
      'index.html': '<h1>v2</h1>', // changed vs prior
      'new.js': 'console.log(1)', // added vs prior
    });
    // Previous approved snapshot: same manifest path with a DIFFERENT sha (so it
    // counts as changed), an index.html with a different sha, and a gone.js that
    // no longer exists (removed). manifest had no contentRating (added field).
    vi.mocked(dbRead.appBlockPublishRequest.findFirst).mockResolvedValue({
      manifest: { blockId: 'demo', version: '0.1.0', name: 'Demo' },
      fileSummary: {
        files: [
          { path: 'block.manifest.json', sha256: 'old-manifest', sizeBytes: 1 },
          { path: 'index.html', sha256: 'old-index', sizeBytes: 1 },
          { path: 'gone.js', sha256: 'old-gone', sizeBytes: 1 },
        ],
      },
    } as never);

    const { fileSummary, manifestDiffSummary } = await computePushDiffSummaries('demo', 'sha2');

    expect(manifestDiffSummary.kind).toBe('update');
    expect(fileSummary.added).toContain('new.js');
    expect(fileSummary.changed).toContain('index.html');
    expect(fileSummary.changed).toContain('block.manifest.json');
    expect(fileSummary.removed).toEqual(['gone.js']);
    if (manifestDiffSummary.kind === 'update') {
      // version + name+contentRating changed/added between 0.1.0 and 0.2.0.
      const touched = [
        ...manifestDiffSummary.added,
        ...manifestDiffSummary.changed.map((c) => c.field),
      ];
      expect(touched).toContain('version');
      expect(touched).toContain('contentRating');
    }
  });
});

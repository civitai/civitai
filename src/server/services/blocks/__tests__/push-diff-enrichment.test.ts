import { beforeEach, describe, expect, it, vi } from 'vitest';

// computePushDiffSummaries reconstructs the bundle from Forgejo (listRepoTreeAtRef
// + getBlobContent) and reads the previous approved version via dbRead;
// enrichPushRequestRow additionally writes via dbWrite. Mock all three so the
// tests drive the real reconstruct → extract → diff pipeline end-to-end without
// a live Forgejo / DB.
vi.mock('../forgejo.service', () => ({
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlockPublishRequest: { findFirst: vi.fn() } },
  dbWrite: { appBlockPublishRequest: { updateMany: vi.fn() } },
}));

import { computePushDiffSummaries, enrichPushRequestRow } from '../publish-request.service';
import { getBlobContent, listRepoTreeAtRef } from '../forgejo.service';
import { dbRead, dbWrite } from '~/server/db/client';

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

    const { fileSummary, manifestDiffSummary, bundleSizeBytes } = await computePushDiffSummaries(
      'demo',
      'sha2'
    );

    expect(manifestDiffSummary.kind).toBe('first-version');
    expect(fileSummary.added.sort()).toEqual(['block.manifest.json', 'index.html']);
    expect(fileSummary.removed).toEqual([]);
    expect(fileSummary.changed).toEqual([]);
    // Real reconstructed bundle size — non-zero (fixes the "0 B · N files" display).
    expect(bundleSizeBytes).toBeGreaterThan(0);
    // The reconstruct pinned the exact pushed ref.
    expect(vi.mocked(listRepoTreeAtRef)).toHaveBeenCalledWith('demo', 'sha2');
  });

  it('diffs against the previous approved version (update)', async () => {
    mockForgejoRepo({
      'block.manifest.json': JSON.stringify(manifestV2),
      'index.html': '<h1>v2</h1>', // changed vs prior
      'new.js': 'console.log(1)', // added vs prior
    });
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
      const touched = [
        ...manifestDiffSummary.added,
        ...manifestDiffSummary.changed.map((c) => c.field),
      ];
      expect(touched).toContain('version');
      expect(touched).toContain('contentRating');
    }
  });
});

describe('enrichPushRequestRow', () => {
  it('writes the computed diff + size, scoped to the still-pending row', async () => {
    mockForgejoRepo({
      'block.manifest.json': JSON.stringify(manifestV2),
      'index.html': '<h1>v2</h1>',
    });
    vi.mocked(dbRead.appBlockPublishRequest.findFirst).mockResolvedValue(null as never);
    vi.mocked(dbWrite.appBlockPublishRequest.updateMany).mockResolvedValue({ count: 1 } as never);

    await enrichPushRequestRow('pubreq_X', 'demo', 'sha2');

    expect(vi.mocked(dbWrite.appBlockPublishRequest.updateMany)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(dbWrite.appBlockPublishRequest.updateMany).mock.calls[0][0] as {
      where: { id: string; status: string };
      data: { bundleSizeBytes: bigint; fileSummary: unknown; manifestDiffSummary: unknown };
    };
    // Scoped so it can't clobber an approved/rejected/superseded row.
    expect(arg.where).toEqual({ id: 'pubreq_X', status: 'pending' });
    expect(typeof arg.data.bundleSizeBytes).toBe('bigint');
    expect(arg.data.bundleSizeBytes).toBeGreaterThan(0n);
    expect(arg.data.fileSummary).toBeDefined();
    expect(arg.data.manifestDiffSummary).toBeDefined();
  });

  it('never throws and writes nothing when Forgejo reconstruct fails', async () => {
    vi.mocked(listRepoTreeAtRef).mockRejectedValue(new Error('forgejo down') as never);

    // The contract the park path relies on: enrichment failure is swallowed so
    // the already-parked review keeps its empty-summary fallback.
    await expect(enrichPushRequestRow('pubreq_Y', 'demo', 'sha2')).resolves.toBeUndefined();
    expect(vi.mocked(dbWrite.appBlockPublishRequest.updateMany)).not.toHaveBeenCalled();
  });
});

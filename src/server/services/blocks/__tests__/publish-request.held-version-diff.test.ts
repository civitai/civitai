import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A version approved over a late hold stays pending, so the next version's review diff must still
// be taken against the last version that went through: v1 approved, v2 held, v3 diffed against v1.
// Runs the real finaliseOnsiteApprove and getPublishRequestDiff over one in-memory request table.

type Row = {
  id: string;
  slug: string;
  status: string;
  reviewedAt: Date | null;
  bundleKey: string;
  forgejoCommitSha: string | null;
};

const { rows, bundles, resolveHoldsAtApprove, requests } = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const requests = {
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    findFirst: async ({
      where,
    }: {
      where: { slug: string; status: string; NOT?: { id: string } };
    }) =>
      [...rows.values()]
        .filter((r) => r.slug === where.slug && r.status === where.status && r.id !== where.NOT?.id)
        .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0))[0] ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error(`no request ${where.id}`);
      Object.assign(row, data);
      return row;
    },
  };
  return { rows, bundles: new Map<string, Buffer>(), resolveHoldsAtApprove: vi.fn(), requests };
});

vi.mock('~/server/services/blocks/publish-request-holds.service', () => ({
  resolveHoldsAtApprove,
}));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => ({
    send: async (cmd: { input: { Key: string } }) => {
      const buf = bundles.get(cmd.input.Key);
      return buf ? { Body: { transformToByteArray: async () => new Uint8Array(buf) } } : {};
    },
  }),
}));

import { finaliseOnsiteApprove } from '~/server/services/blocks/publish-request-finalise.service';
import { getPublishRequestDiff } from '~/server/services/blocks/publish-request.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const SLUG = 'held-diff';

async function submit(id: string, appJs: string) {
  const zip = new JSZip();
  zip.file('app.js', appJs);
  bundles.set(`b/${id}`, await zip.generateAsync({ type: 'nodebuffer' }));
  rows.set(id, {
    id,
    slug: SLUG,
    status: 'pending',
    reviewedAt: null,
    bundleKey: `b/${id}`,
    forgejoCommitSha: null,
  });
}

async function approve(id: string, lateHoldIds: number[]) {
  resolveHoldsAtApprove.mockResolvedValueOnce({ late: lateHoldIds });
  const tx = {
    $queryRaw: async () => [],
    appBlockPublishRequest: requests,
    appBlock: {
      update: async () => ({}),
      findUnique: async () => ({ appId: 'appblk-held-diff', status: 'suspended' }),
      count: async () => 0,
    },
    apiKey: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    appListing: { updateMany: async () => ({ count: 0 }) },
  };
  return finaliseOnsiteApprove(tx as never, {
    holdDecision: { slug: SLUG },
    reviewerUserId: 1,
    publishRequestId: id,
    appBlockId: 'blk_1',
    forgejoCommitSha: 'a'.repeat(40),
    screenshots: {},
  });
}

describe('the review diff after a version held at approve', () => {
  beforeEach(() => {
    rows.clear();
    bundles.clear();
    resolveHoldsAtApprove.mockReset();
    for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
      client.appBlockPublishRequest.findUnique.mockImplementation(requests.findUnique);
      client.appBlockPublishRequest.findFirst.mockImplementation(requests.findFirst);
    }
  });

  it('🔴 v3 is diffed against v1, so the held v2 change still shows', async () => {
    await submit('v1', 'one\n');
    await approve('v1', []);
    await submit('v2', 'two\n');
    expect((await approve('v2', [7])).lateHoldIds).toEqual([7]);
    expect(rows.get('v2')?.status).toBe('pending');

    // v3 repeats v2's code: diffed against v2 it would show no change at all.
    await submit('v3', 'two\n');
    const diff = await getPublishRequestDiff({ publishRequestId: 'v3' });

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: 'app.js',
      changeKind: 'changed',
      added: 1,
      removed: 1,
    });
  });
});

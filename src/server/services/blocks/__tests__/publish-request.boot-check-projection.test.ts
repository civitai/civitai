import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMode } = vi.hoisted(() => ({ mockMode: { value: 'off' as string } }));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: (slug: string) => `https://forgejo.example/review/${slug}`,
  repoCommitUrl: (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`,
}));
vi.mock('~/server/services/blocks/review-boot-check.service', () => ({
  readReviewBootCheckMode: async () => mockMode.value,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import { listPendingRequests } from '~/server/services/blocks/publish-request.service';

/**
 * The queue's boot-check projections: `previewBootCheck` (the recorded result + mode, never the
 * rest of the detail) and `previewBootCheckUnverified` ("Boot check not run": the CURRENT flag is
 * enforce and the row has no enforced pass). Approve stays enabled either way.
 */

function seed(deployState: string | null, bootCheck: unknown) {
  dbMock.dbRead.appBlockPublishRequest.findMany.mockResolvedValue([
    {
      id: 'pubreq_1',
      appBlockId: null,
      slug: 'sketch',
      version: '1.0.0',
      submittedAt: new Date('2026-03-01T00:00:00Z'),
      bundleSizeBytes: BigInt(10),
      bundleSha256: 'sha',
      manifest: {},
      fileSummary: {},
      manifestDiffSummary: {},
      forgejoCommitSha: null,
      deployState,
      deployDetail: JSON.stringify({ sha: 'a', host: 'h', bootCheck }),
      deployUpdatedAt: new Date(),
      submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
    },
  ] as never);
  dbMock.dbRead.appListing.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.$queryRaw.mockImplementation((async () => []) as never);
}

type Row = {
  previewBootCheck?: unknown;
  previewBootCheckUnverified?: unknown;
  deployDetail?: unknown;
};
const row = async () => (await listPendingRequests({ limit: 10 })).items[0] as Row;

beforeEach(() => {
  resetHybridNodes();
  mockMode.value = 'off';
});

describe('listPendingRequests — boot-check projections', () => {
  it('projects the recorded result + mode only, never the detail', async () => {
    seed('preview-live', { result: 'passed', mode: 'enforce', firstError: null, ms: 9 });
    const r = await row();
    expect(r.previewBootCheck).toEqual({ result: 'passed', mode: 'enforce' });
    expect('deployDetail' in (r as object)).toBe(false);
  });

  it.each([
    ['enforce', 'preview-live', undefined, true],
    ['enforce', 'preview-live', { result: 'unavailable', mode: 'enforce' }, true],
    ['enforce', 'preview-live', { result: 'passed', mode: 'shadow' }, true],
    ['enforce', null, undefined, true],
    ['enforce', 'preview-live', { result: 'passed', mode: 'enforce' }, false],
    ['shadow', 'preview-live', undefined, false],
    ['off', 'preview-live', undefined, false],
  ])(
    '🔴 current flag %s, state %s, recorded %j → unverified %s',
    async (mode, state, bootCheck, unverified) => {
      mockMode.value = mode;
      seed(state, bootCheck);
      expect((await row()).previewBootCheckUnverified).toBe(unverified);
    }
  );
});

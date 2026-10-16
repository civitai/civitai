import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AutoMute from '~/server/services/scam-auto-mute.service';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as ReportService from '~/server/services/report.service';

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanCsamMode: vi.fn(async () => 'review'),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  createReport: vi.fn(),
}));
vi.mock('~/server/services/scam-auto-mute.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AutoMute>()),
  autoMuteScamAccount: vi.fn(async () => ({ muted: false, skipped: 'duplicate' })),
}));
// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));
// Hand-listed: the real action pulls model-version.service and nsfwLevels.service at load.
vi.mock('~/server/services/text-scan/actions/model-nsfw', () => ({
  applyModelNsfwTextScan: vi.fn(async () => ({ deferredRatingNotice: null })),
  applySystemModelNsfwFlag: vi.fn(),
}));
// Hand-listed: the real action reaches model.service, whose graph builds clients at load.
vi.mock('~/server/services/text-scan/actions/model-poi-minor', () => ({
  applyModelPoiMinor: vi.fn(async () => ({ notified: false })),
}));

const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { applyCsamHold } = await import('~/server/services/text-scan/actions/csam-hold');
const { getTextScanCsamMode } = await import('~/server/services/text-scan/mode');
const { createReport } = await import('~/server/services/report.service');
const { autoMuteScamAccount } = await import('~/server/services/scam-auto-mute.service');
const { applyRatingFloor } = await import('~/server/services/text-scan/rated-entities');
const { applyModelPoiMinor } = await import('~/server/services/text-scan/actions/model-poi-minor');

type HoldRow = Record<string, unknown> & { id: number };
let holds: HoldRow[] = [];
const holdKey = (row: Record<string, unknown>) =>
  [row.entityType, row.entityId, row.label, row.textHash].join('|');

beforeEach(() => {
  vi.clearAllMocks();
  holds = [];
  // Stands in for the (entityType, entityId, label, textHash) unique index.
  dbMock.dbWrite.textScanHold.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      if (holds.some((row) => holdKey(row) === holdKey(data)))
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      const row = { id: holds.length + 1, status: 'Pending', ...data };
      holds.push(row);
      return row;
    }
  );
});

const csamOnly = {
  csam: { detected: true, reason: 'test' },
  triggeredLabels: ['csam' as const],
  nsfwLevel: null,
};
const args = (over: Record<string, unknown> = {}) => ({
  entityId: 77,
  workflowId: 'wf-1',
  outcome: csamOnly,
  subject: {
    fields: [{ heading: 'Comment', text: 'neutral text' }],
    declared: {},
    userId: 5,
    meta: { contentAt: '2026-10-01T00:00:00.000Z', chatId: 4, messageIds: [77, 70] },
  },
  textHash: 'hash-1',
  ...over,
});

const WIRED = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'UserProfile',
  'User',
  'ResourceReview',
  'Model',
  'Post',
] as const;

describe('csam verdicts through the registered adapters', () => {
  it.each(WIRED)('%s records one pending hold and nothing else', async (entityType) => {
    const adapter = getModerationAdapter(entityType)!;
    await adapter.applyTextScan!(args() as never);
    await adapter.applyTextScan!(args({ workflowId: 'wf-redelivered' }) as never);

    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      entityType,
      entityId: 77,
      label: 'csam',
      textHash: 'hash-1',
      status: 'Pending',
      reason: 'test',
      userId: 5,
      workflowId: 'wf-1',
    });
    expect(createReport).not.toHaveBeenCalled();
    expect(autoMuteScamAccount).not.toHaveBeenCalled();
  });

  it('records nothing while the gate is off', async () => {
    vi.mocked(getTextScanCsamMode).mockResolvedValueOnce('off');
    await getModerationAdapter('Comment')!.applyTextScan!(args() as never);
    expect(dbMock.dbWrite.textScanHold.create).not.toHaveBeenCalled();
  });

  it('records nothing for a verdict without csam', async () => {
    await getModerationAdapter('Comment')!.applyTextScan!(
      args({ outcome: { csam: { detected: false, reason: 'test' }, triggeredLabels: [] } }) as never
    );
    expect(holds).toHaveLength(0);
  });

  it('holds changed text again, leaving the earlier hold', async () => {
    const adapter = getModerationAdapter('Post')!;
    await adapter.applyTextScan!(args() as never);
    await adapter.applyTextScan!(args({ textHash: 'hash-2' }) as never);
    expect(holds.map((row) => row.textHash)).toEqual(['hash-1', 'hash-2']);
  });

  it('holds before the scam action runs, and still mutes on a scam verdict', async () => {
    const outcome = { ...csamOnly, scam: { detected: true, reason: 'test' } };
    await getModerationAdapter('ChatMessage')!.applyTextScan!(args({ outcome }) as never);
    expect(holds).toHaveLength(1);
    expect(vi.mocked(dbMock.dbWrite.textScanHold.create).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(autoMuteScamAccount).mock.invocationCallOrder[0]
    );
  });

  it.each([
    ['ChatMessage', () => autoMuteScamAccount],
    ['Post', () => applyRatingFloor],
    ['Model', () => applyModelPoiMinor],
  ] as const)(
    '%s still runs its own action when the hold write fails, then fails the callback',
    async (entityType, action) => {
      dbMock.dbWrite.textScanHold.create.mockRejectedValueOnce(new Error('db down'));
      const outcome = { ...csamOnly, scam: { detected: true, reason: 'test' } };
      await expect(
        getModerationAdapter(entityType)!.applyTextScan!(args({ outcome }) as never)
      ).rejects.toThrow('db down');
      expect(action()).toHaveBeenCalled();
    }
  );
});

describe('applyCsamHold', () => {
  it('stores the scanned text, the csam prompt and the chat window', async () => {
    await applyCsamHold({ entityType: 'ChatMessage', ...args(), promptIds: { base: 1, csam: 9 } });
    expect(holds[0]).toMatchObject({
      text: expect.stringContaining('neutral text'),
      promptId: 9,
      contentAt: new Date('2026-10-01T00:00:00.000Z'),
      meta: { chatId: 4, messageIds: [77, 70] },
    });
  });

  it.each([undefined, 0, -1])('stores no author for user id %s', async (userId) => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      subject: { ...base.subject, userId },
    });
    expect(holds[0].userId).toBeNull();
  });
});

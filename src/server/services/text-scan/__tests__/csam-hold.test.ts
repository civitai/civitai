import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
const { applyCsamHold, CSAM_HOLD_TEXT_CHARS } = await import(
  '~/server/services/text-scan/actions/csam-hold'
);
const { composeUserText } = await import('~/server/services/text-scan/segment');
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
    '%s fails the callback without running its own action when the hold write fails',
    async (entityType, action) => {
      dbMock.dbWrite.textScanHold.create.mockRejectedValueOnce(new Error('db down'));
      const outcome = { ...csamOnly, scam: { detected: true, reason: 'test' } };
      await expect(
        getModerationAdapter(entityType)!.applyTextScan!(args({ outcome }) as never)
      ).rejects.toThrow('db down');
      expect(action()).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', entityType, entityId: 77, workflowId: 'wf-1' })
      );
    }
  );

  it('records the hold on the retry after a failed write, and acts once', async () => {
    dbMock.dbWrite.textScanHold.create.mockRejectedValueOnce(new Error('db down'));
    const outcome = { ...csamOnly, scam: { detected: true, reason: 'test' } };
    const adapter = getModerationAdapter('ChatMessage')!;
    await expect(adapter.applyTextScan!(args({ outcome }) as never)).rejects.toThrow();
    await adapter.applyTextScan!(args({ outcome, workflowId: 'wf-retry' }) as never);
    expect(holds).toHaveLength(1);
    expect(autoMuteScamAccount).toHaveBeenCalledTimes(1);
  });

  it('fails the callback when the hold write throws a falsy value', async () => {
    dbMock.dbWrite.textScanHold.create.mockImplementationOnce(() => Promise.reject(undefined));
    await expect(getModerationAdapter('Comment')!.applyTextScan!(args() as never)).rejects.toBe(
      undefined
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', entityType: 'Comment' })
    );
  });

  it('records the csam prompt id handed over by the callback', async () => {
    await getModerationAdapter('Post')!.applyTextScan!(
      args({ promptIds: { base: 1, csam: 9 } }) as never
    );
    expect(holds[0].promptId).toBe(9);
  });
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

  // Postgres rejects both in text and in jsonb, so a stored one would fail every retry.
  const UNSTORABLE =
    /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
      ? Object.values(value).flatMap(strings)
      : [];

  const unstorable = (row: HoldRow) =>
    [row.text, row.reason, ...strings(row.meta)].filter(
      (v): v is string => typeof v === 'string' && UNSTORABLE.test(v)
    );

  it('strips NUL from the text, the reason and every string in meta', async () => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      outcome: { ...csamOnly, csam: { detected: true, reason: 'te\u0000st' } },
      subject: {
        ...base.subject,
        fields: [{ heading: 'Comment', text: 'neutral\u0000text' }],
        meta: { note: 'a\u0000b', nested: { list: ['c\u0000d', 4] } },
      },
    });
    expect(holds[0].text).toContain('neutraltext');
    expect(holds[0].reason).toBe('test');
    expect(holds[0].meta).toEqual({ note: 'ab', nested: { list: ['cd', 4] } });
    expect(unstorable(holds[0])).toEqual([]);
  });

  it('replaces lone surrogates in the text, the reason and nested meta strings', async () => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      outcome: { ...csamOnly, csam: { detected: true, reason: 'low \uDC00 high' } },
      subject: {
        ...base.subject,
        fields: [{ heading: 'Comment', text: 'neutral \uD800 text' }],
        meta: { nested: { list: ['a\uDBFFb', 4], note: 'x\uDFFF' } },
      },
    });
    expect(holds[0].text).toContain('neutral \uFFFD text');
    expect(holds[0].reason).toBe('low \uFFFD high');
    expect(holds[0].meta).toEqual({ nested: { list: ['a\uFFFDb', 4], note: 'x\uFFFD' } });
    expect(unstorable(holds[0])).toEqual([]);
  });

  it('keeps a whole surrogate pair', async () => {
    const base = args();
    await applyCsamHold({
      entityType: 'Comment',
      ...base,
      subject: { ...base.subject, fields: [{ heading: 'Comment', text: 'smile \u{1F600}' }] },
    });
    expect(holds[0].text).toContain('smile \u{1F600}');
  });

  it('cuts the text at the cap without leaving half a surrogate pair', async () => {
    const base = args();
    const at = composeUserText({
      ...base.subject,
      fields: [{ heading: 'Comment', text: 'X' }],
    }).indexOf('X');
    const text = 'a'.repeat(CSAM_HOLD_TEXT_CHARS - 1 - at) + '\u{1F600}' + 'tail';
    const subject = { ...base.subject, fields: [{ heading: 'Comment', text }] };
    expect(composeUserText(subject).charCodeAt(CSAM_HOLD_TEXT_CHARS - 1)).toBe(0xd83d);
    await applyCsamHold({ entityType: 'Comment', ...base, subject });
    const stored = holds[0].text as string;
    expect(stored.length).toBeLessThanOrEqual(CSAM_HOLD_TEXT_CHARS);
    expect(UNSTORABLE.test(stored)).toBe(false);
  });
});

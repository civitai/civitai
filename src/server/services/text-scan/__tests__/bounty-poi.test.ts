import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SearchIndexUpdateModule from '~/server/search-index/SearchIndexUpdate';
import type * as ReportService from '~/server/services/report.service';
import type * as AppealTextHash from '~/server/services/text-scan/actions/appeal-text-hash';
import type { TextScanOutcome } from '~/server/services/text-scan/types';

const {
  mockQueueUpdate,
  mockCreateNotification,
  mockResolveEntityAppeal,
  mockLoadTextScanTextHash,
  mockQueueTextScanRescan,
} = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockResolveEntityAppeal: vi.fn(),
  mockLoadTextScanTextHash: vi.fn(),
  mockQueueTextScanRescan: vi.fn(),
}));

vi.mock('~/server/search-index/SearchIndexUpdate', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndexUpdateModule>()),
  SearchIndexUpdate: { queueUpdate: mockQueueUpdate },
}));
// Hand-listed: the real module constructs the notifications client at load.
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  resolveEntityAppeal: mockResolveEntityAppeal,
}));
vi.mock('~/server/services/text-scan/actions/appeal-text-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof AppealTextHash>()),
  loadTextScanTextHash: mockLoadTextScanTextHash,
  queueTextScanRescan: mockQueueTextScanRescan,
}));

const { applyBountyPoi, resolveBountyPoiAppeal } = await import(
  '~/server/services/text-scan/actions/bounty-poi'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const sqlOf = (call: unknown[]) => Array.from(call[0] as TemplateStringsArray).join('?');
const outcome = (
  poi: Partial<NonNullable<TextScanOutcome['poi']>> | undefined
): TextScanOutcome => ({
  triggeredLabels: [],
  nsfwLevel: null,
  poi: poi && {
    detected: true,
    declared: false,
    newlyDetected: true,
    names: ['Jane Doe'],
    reason: 'Names a real actor.',
    ...poi,
  },
});
const SUBJECT = { fields: [{ heading: 'Name', text: 'B' }], declared: {} };
const run = (o: TextScanOutcome) =>
  applyBountyPoi({
    entityId: 9,
    workflowId: 'wf-1',
    outcome: o,
    subject: SUBJECT,
    textHash: textScanTextHash(SUBJECT),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadTextScanTextHash.mockResolvedValue('h-text');
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 9, name: 'B', userId: 42 }]);
});

describe('applyBountyPoi', () => {
  it('does nothing unless poi is detected', async () => {
    await run(outcome({ detected: false, newlyDetected: false }));
    await run(outcome(undefined));
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  // A bounty depicting a real person is not allowed at all, so a declared poi is no excuse.
  it('still hides a bounty whose owner declared poi', async () => {
    await run(outcome({ declared: true, newlyDetected: false }));
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('hides, sets and locks poi in one guarded write with a pre-flag snapshot', async () => {
    await run(outcome({}));
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toContain('poi = TRUE');
    expect(text).toContain(`availability = 'Private'::"Availability"`);
    expect(text).toContain(`ARRAY['poi']::text[]`);
    expect(text).toContain(`'prev', jsonb_build_object('availability', b.availability`);
    // Two arms: never flagged and not moderator-locked, OR a granted appeal on different text.
    expect(text).toMatch(
      /->'poi' IS NULL\s+AND NOT \('poi' = ANY\(COALESCE\(b\."lockedProperties", ARRAY\[\]::text\[\]\)\)\)\)\s+OR \(b\.meta->\?->'poi'->'appealGranted' IS NOT NULL\s+AND b\.meta->\?->'poi'->'appealGranted'->>'textHash' IS DISTINCT FROM /
    );
    expect(call.slice(1)).toContain(textScanTextHash(SUBJECT));
    const entry = JSON.parse(
      call.slice(1).find((v) => typeof v === 'string' && v.includes('wf-1')) as string
    );
    expect(entry.names).toEqual(['Jane Doe']);
    expect(entry.textHash).toBe(textScanTextHash(SUBJECT));
  });

  // Review Focus 5.
  it('queues a search delete — the index never drops a row that stops matching', async () => {
    await run(outcome({}));
    expect(mockQueueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ id: 9, action: 'Delete' }] })
    );
  });

  it('notifies the owner once, keyed by the workflow', async () => {
    expect(await run(outcome({}))).toEqual({ notified: true });
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        type: 'bounty-text-scan-flagged',
        key: 'bounty-text-scan-flagged:9:wf-1',
        details: { bountyId: 9, bountyName: 'B' },
      })
    );
  });

  // Review Focus 1.
  it('redelivery does nothing when the guarded write returned no row', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(await run(outcome({}))).toEqual({ notified: false });
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips the notification for an ownerless bounty', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 9, name: 'B', userId: null }]);
    expect(await run(outcome({}))).toEqual({ notified: false });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('resolveBountyPoiAppeal', () => {
  const poiEntry = {
    at: 'x',
    workflowId: 'wf-1',
    reason: 'r',
    textHash: 'h-flagged',
    prev: { availability: 'Unsearchable' },
  };

  beforeEach(() => {
    mockLoadTextScanTextHash.mockResolvedValue('h-current');
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue({
      poi: true,
      meta: { textScanFlags: { poi: poiEntry } },
    });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  });

  it('overturn restores visibility, keeps the poi lock, stamps the grant and reindexes', async () => {
    await resolveBountyPoiAppeal({ bountyId: 9, uphold: false, userId: 3 });

    const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toContain('poi = FALSE');
    expect(text).toContain(
      `availability = COALESCE((b.meta->?->'poi'->'prev'->>'availability')::"Availability", 'Public'::"Availability")`
    );
    expect(text).toContain(`ARRAY['poi']::text[]`);
    expect(text).toContain(`'appealGranted'`);
    expect(text).toContain(`'textHash', COALESCE(b.meta->?->'poi'->>'textHash', `);
    expect(text).toContain(`'via', 'appeal'`);
    // The current hash is only the fallback bind; the flagged hash stays in the row.
    expect(call.slice(1)).toContain('h-current');
    expect(call.slice(1)).not.toContain('h-flagged');
    expect(mockLoadTextScanTextHash).toHaveBeenCalledWith('Bounty', 9);
    expect(mockQueueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ id: 9, action: 'Update' }] })
    );
    expect(mockResolveEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [9], entityType: 'Bounty', status: 'Approved', userId: 3 })
    );
  });

  it('uphold stamps the decision and rejects the appeal', async () => {
    await resolveBountyPoiAppeal({ bountyId: 9, uphold: true, userId: 3 });
    expect(sqlOf(dbMock.dbWrite.$executeRaw.mock.calls[0])).toContain(`'appealUpheld'`);
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(mockResolveEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Rejected' })
    );
  });

  it('refuses to uphold a bounty that is no longer flagged', async () => {
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue({
      poi: false,
      meta: { textScanFlags: { poi: poiEntry } },
    });
    await expect(
      resolveBountyPoiAppeal({ bountyId: 9, uphold: true, userId: 3 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
  });

  it('leaves the appeal open when the restore write fails', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(new Error('boom'));
    await expect(resolveBountyPoiAppeal({ bountyId: 9, uphold: false, userId: 3 })).rejects.toThrow(
      'boom'
    );
    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
  });

  // Review Focus 2.
  it('refuses to overturn, leaving the appeal open, when the text hash is unknown', async () => {
    mockLoadTextScanTextHash.mockResolvedValue(null);
    await expect(
      resolveBountyPoiAppeal({ bountyId: 9, uphold: false, userId: 3 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
  });

  // Review Focus 2.
  it('queues a rescan after resolving when the text changed while the appeal was pending', async () => {
    expect(await resolveBountyPoiAppeal({ bountyId: 9, uphold: false, userId: 3 })).toEqual({
      rescanQueued: true,
    });
    expect(mockQueueTextScanRescan).toHaveBeenCalledWith('Bounty', 9);
    expect(mockResolveEntityAppeal).toHaveBeenCalled();
    expect(mockResolveEntityAppeal.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueueTextScanRescan.mock.invocationCallOrder[0]
    );
  });

  it('queues no rescan when the text is unchanged', async () => {
    mockLoadTextScanTextHash.mockResolvedValue('h-flagged');
    expect(await resolveBountyPoiAppeal({ bountyId: 9, uphold: false, userId: 3 })).toEqual({
      rescanQueued: false,
    });
    expect(mockQueueTextScanRescan).not.toHaveBeenCalled();
  });
});

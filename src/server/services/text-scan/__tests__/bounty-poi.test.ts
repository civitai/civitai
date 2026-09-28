import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SearchIndexUpdateModule from '~/server/search-index/SearchIndexUpdate';
import type { TextScanOutcome } from '~/server/services/text-scan/types';

const { mockQueueUpdate, mockCreateNotification } = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(),
  mockCreateNotification: vi.fn(),
}));

vi.mock('~/server/search-index/SearchIndexUpdate', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndexUpdateModule>()),
  SearchIndexUpdate: { queueUpdate: mockQueueUpdate },
}));
// Hand-listed: the real module constructs the notifications client at load.
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { applyBountyPoi } = await import('~/server/services/text-scan/actions/bounty-poi');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const sqlOf = (call: unknown[]) => Array.from(call[0] as TemplateStringsArray).join('?');
const outcome = (poi: Partial<NonNullable<TextScanOutcome['poi']>> | undefined): TextScanOutcome => ({
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
    expect(sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0])).not.toContain('NOT b.poi');
  });

  it('hides, sets and locks poi in one guarded write with a pre-flag snapshot', async () => {
    await run(outcome({}));
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toContain('poi = TRUE');
    expect(text).toContain(`availability = 'Private'::"Availability"`);
    expect(text).toContain(`ARRAY['poi']::text[]`);
    expect(text).toContain(`'prev', jsonb_build_object('availability', b.availability`);
    expect(text).toContain(`->'poi' IS NULL`);
    expect(text).toContain(`->'appealGranted'->>'textHash' IS DISTINCT FROM `);
    expect(call.slice(1)).toContain(textScanTextHash(SUBJECT));
    const entry = JSON.parse(call.slice(1).find((v) => typeof v === 'string' && v.includes('wf-1')) as string);
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

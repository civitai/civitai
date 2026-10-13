import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { TextScanOutcome } from '~/server/services/text-scan/types';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const { mockSetModelMinor, mockSideEffects, mockCreateNotification, entityChangesMock } =
  vi.hoisted(() => ({
    mockSetModelMinor: vi.fn(),
    mockSideEffects: vi.fn(),
    mockCreateNotification: vi.fn(),
    entityChangesMock: vi.fn(),
  }));

// Hand-listed: the real model.service pulls the whole model graph (meili, prom, redis) at load.
vi.mock('~/server/services/model.service', () => ({
  setModelMinor: mockSetModelMinor,
  applyModelFlagSideEffects: mockSideEffects,
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = entityChangesMock;
  },
}));

const {
  applyModelPoiMinor,
  grantModelTextScanPoi,
  reassertModelPoiRestrictions,
  stampModelTextScanAppeal,
  POI_LOCKED_PROPERTIES,
} = await import('~/server/services/text-scan/actions/model-poi-minor');
const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { bustPublicModelResponseCache } = await import('~/server/services/model-version.service');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const MODEL_ID = 7;
const sqlOf = (call: unknown[]) => Array.from(call[0] as TemplateStringsArray).join('?');

const poi = (over = {}) => ({
  detected: true,
  declared: false,
  newlyDetected: true,
  names: ['Jane Doe'],
  reason: 'Names a real actor.',
  ...over,
});
const minor = (over = {}) => ({
  detected: true,
  declared: false,
  newlyDetected: true,
  reason: 'Describes a child.',
  ...over,
});
const outcome = (o: Partial<TextScanOutcome>): TextScanOutcome => ({
  triggeredLabels: [],
  nsfwLevel: null,
  ...o,
});
const run = (o: TextScanOutcome, subject = SUBJECT) =>
  applyModelPoiMinor({
    entityId: MODEL_ID,
    workflowId: 'wf-1',
    outcome: o,
    subject,
    textHash: textScanTextHash(subject),
  });

const storedModel = (over: Record<string, unknown> = {}) => ({
  userId: 42,
  name: 'My Model',
  poi: false,
  minor: false,
  nsfw: true,
  sfwOnly: false,
  gallerySettings: { level: 31 },
  lockedProperties: [],
  meta: {},
  ...over,
});
const SUBJECT = { fields: [{ heading: 'Name', text: 'My Model' }], declared: {} };
const EDITED = { fields: [{ heading: 'Name', text: 'My Model, edited' }], declared: {} };
const granted = (label: 'poi' | 'minor', textHash: string) => ({
  textScanFlags: {
    [label]: { at: 'x', workflowId: 'w', reason: 'r', appealGranted: { at: 'x', by: 1, textHash } },
  },
});
const flaggedRow = {
  id: MODEL_ID,
  name: 'My Model',
  description: null,
  userId: 42,
  poi: true,
  nsfw: false,
  minor: false,
  sfwOnly: true,
  status: 'Published',
  gallerySettings: { level: sfwBrowsingLevelsFlag },
  lockedProperties: ['poi', 'nsfw', 'sfwOnly'],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel());
  dbMock.dbWrite.$queryRaw.mockResolvedValue([flaggedRow]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  entityChangesMock.mockResolvedValue(undefined);
});

describe('applyModelPoiMinor — nothing to do', () => {
  it('reads nothing when no label is newly detected, and never writes a false', async () => {
    await run(
      outcome({
        poi: poi({ detected: false, newlyDetected: false, names: [] }),
        minor: minor({ detected: true, declared: true, newlyDetected: false }),
      })
    );
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('does nothing for a model deleted before the callback', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await run(outcome({ poi: poi(), minor: minor() }));
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });
});

describe('applyModelPoiMinor — poi', () => {
  it('sets, restricts and locks in one guarded write that snapshots the pre-flag state', async () => {
    await run(outcome({ poi: poi() }));

    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toContain('poi = TRUE');
    expect(text).toContain('nsfw = FALSE');
    expect(text).toContain('"sfwOnly" = TRUE');
    expect(text).toContain(`'prev', jsonb_build_object(`);
    expect(text).toContain('FROM "EntityModeration" em');
    expect(text).toContain('NOT m.poi');
    expect(text).toContain(`NOT ('poi' = ANY(`);
    expect(text).toContain(`->'appealGranted' IS NULL`);
    expect(text).toContain(`->'appealGranted'->>'textHash' IS DISTINCT FROM `);
    expect(text).toContain('RETURNING');

    const values = call.slice(1);
    expect(values).toContainEqual(POI_LOCKED_PROPERTIES);
    expect(values).toContain(sfwBrowsingLevelsFlag);
    const entry = JSON.parse(
      values.find((v) => typeof v === 'string' && v.includes('wf-1')) as string
    );
    expect(entry).toEqual({
      workflowId: 'wf-1',
      reason: 'Names a real actor.',
      names: ['Jane Doe'],
      textHash: textScanTextHash(SUBJECT),
    });
  });

  it('runs the flag side effects, recomputes levels when nsfw flipped, and notifies once', async () => {
    await run(outcome({ poi: poi() }));

    expect(mockSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ poi: false }),
        after: flaggedRow,
      })
    );
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
    expect(bustPublicModelResponseCache).toHaveBeenCalledWith(MODEL_ID);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        type: 'model-text-scan-flagged',
        key: `model-text-scan-flagged:${MODEL_ID}:poi:wf-1`,
        details: { modelId: MODEL_ID, modelName: 'My Model', label: 'poi' },
      })
    );
  });

  // Review Focus 1: the notifications worker reuses a Notification row by key, so a key without
  // the workflow would deliver the first flag and swallow every later re-flag.
  it('the key carries the workflow, so a later re-flag reaches the owner', async () => {
    await applyModelPoiMinor({
      entityId: MODEL_ID,
      workflowId: 'wf-2',
      outcome: outcome({ poi: poi() }),
      subject: SUBJECT,
      textHash: textScanTextHash(SUBJECT),
    });
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: `model-text-scan-flagged:${MODEL_ID}:poi:wf-2` })
    );
  });

  it('reports that it notified, so the adapter does not also send the rating notice', async () => {
    expect(await run(outcome({ poi: poi() }))).toEqual({ notified: true });
  });

  it('skips the level recompute when the model was already SFW', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ nsfw: false }));
    await run(outcome({ poi: poi() }));
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
  });

  // Review Focus 1.
  it('redelivery sends nothing: a write that returned no row did not flag', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(await run(outcome({ poi: poi() }))).toEqual({ notified: false });
    expect(mockSideEffects).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('is a no-op when the model is already poi', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ poi: true }));
    await run(outcome({ poi: poi() }));
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  // Review Focus 2.
  it('skips a locked label with no granted appeal — a moderator ruling', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ lockedProperties: ['poi'] }));
    await run(outcome({ poi: poi() }));
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips a granted appeal while the text is unchanged, and reports no notice', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({ lockedProperties: ['poi'], meta: granted('poi', textScanTextHash(SUBJECT)) })
    );
    expect(await run(outcome({ poi: poi() }))).toEqual({ notified: false });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('re-flags a grant that carries no text hash — it covers nothing', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({
        lockedProperties: ['poi'],
        meta: {
          textScanFlags: {
            poi: { at: 'x', workflowId: 'w', reason: 'r', appealGranted: { at: 'x', by: 1 } },
          },
        },
      })
    );
    await run(outcome({ poi: poi() }));
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('still skips when only the prompts or model changed (same text)', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({ lockedProperties: ['poi'], meta: granted('poi', textScanTextHash(SUBJECT)) })
    );
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      contentHash: 'new-prompt-version-hash',
    });
    await applyModelPoiMinor({
      entityId: MODEL_ID,
      workflowId: 'wf-new-prompts',
      outcome: outcome({ poi: poi({ reason: 'New prompt wording.' }) }),
      subject: SUBJECT,
      textHash: textScanTextHash(SUBJECT),
    });
    expect(dbMock.dbWrite.entityModeration.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('re-flags and notifies once the text changed after a granted appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({ lockedProperties: ['poi'], meta: granted('poi', textScanTextHash(SUBJECT)) })
    );
    await run(outcome({ poi: poi() }), EDITED);
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    expect(call.slice(1)).toContain(textScanTextHash(EDITED));
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: `model-text-scan-flagged:${MODEL_ID}:poi:wf-1` })
    );
  });

  it('does not notify a model owned by the system/deleted-user account', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ ...flaggedRow, userId: -1 }]);
    await run(outcome({ poi: poi() }));
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('applyModelPoiMinor — minor', () => {
  it('records the verdict, then flags through setModelMinor as text-scan, then notifies', async () => {
    await run(outcome({ minor: minor() }));

    const write = dbMock.dbWrite.$executeRaw.mock.calls[0];
    const text = sqlOf(write);
    expect(text).toContain(`'minor', `);
    expect(text).toContain('NOT m.minor');
    expect(text).toContain(`NOT ('minor' = ANY(`);
    expect(mockSetModelMinor).toHaveBeenCalledWith({
      id: MODEL_ID,
      minor: true,
      userId: -1,
      activity: 'setMinorTextScan',
    });
    expect(dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetModelMinor.mock.invocationCallOrder[0]
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: `model-text-scan-flagged:${MODEL_ID}:minor:wf-1` })
    );
    expect(
      JSON.parse(write.slice(1).find((v) => typeof v === 'string' && v.includes('wf-1')) as string)
    ).toMatchObject({
      textHash: textScanTextHash(SUBJECT),
    });
  });

  it('redelivery sends nothing when the guarded write affected no row', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    await run(outcome({ minor: minor() }));
    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['already minor', { minor: true }],
    ['minor locked', { lockedProperties: ['minor'] }],
    [
      'appeal granted on unchanged text',
      { lockedProperties: ['minor'], meta: granted('minor', textScanTextHash(SUBJECT)) },
    ],
  ])('skips when %s', async (_label, over) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel(over));
    await run(outcome({ minor: minor() }));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('re-flags minor and notifies once the text changed after a granted appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({
        lockedProperties: ['minor'],
        meta: granted('minor', textScanTextHash(SUBJECT)),
      })
    );
    await run(outcome({ minor: minor() }), EDITED);
    const write = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect(sqlOf(write)).toContain(`->'appealGranted'->>'textHash' IS DISTINCT FROM `);
    expect(write.slice(1)).toContain(textScanTextHash(EDITED));
    expect(mockSetModelMinor).toHaveBeenCalledWith(
      expect.objectContaining({ minor: true, activity: 'setMinorTextScan' })
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: `model-text-scan-flagged:${MODEL_ID}:minor:wf-1` })
    );
  });
});

describe('applyModelPoiMinor — both labels', () => {
  it('applies poi before minor so the undo order is fixed', async () => {
    await run(outcome({ poi: poi(), minor: minor() }));
    expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetModelMinor.mock.invocationCallOrder[0]
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });
});

describe('grantModelTextScanPoi', () => {
  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({
        poi: true,
        nsfw: false,
        sfwOnly: true,
        lockedProperties: ['poi', 'nsfw', 'sfwOnly'],
      })
    );
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ ...flaggedRow, poi: false }]);
  });

  // Review Focus 2.
  it('clears poi and keeps the poi lock so a rescan of the same text cannot put it back', async () => {
    expect(
      await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' })
    ).toBe(true);
    const text = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(text).toContain('poi = FALSE');
    expect(text).toContain(`ARRAY['poi']::text[]`);
    // nsfw/sfwOnly locks stay while minor holds them, or when they predate the poi flag.
    expect(text).toMatch(
      /WHERE p = 'poi'\s+OR m\.minor\s+OR p NOT IN \('nsfw', 'sfwOnly'\)\s+OR p IN \(SELECT jsonb_array_elements_text\(m\.meta->\?->'poi'->'prev'->'lockedProperties'\)\)/
    );
  });

  // A grant recorded apart from the lift would outlive a failed lift, and a recorded grant reads as
  // lifted, so nothing could retry it.
  it('records the appeal grant in the statement that lifts poi', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' });
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toMatch(
      /meta = jsonb_set\(\s+m\.meta,\s+ARRAY\[\?::text, 'poi', 'appealGranted'\]/
    );
    expect(text).toContain(`'textHash', COALESCE(m.meta->?->'poi'->>'textHash', ?::text)`);
    expect(text).toContain(`'via', 'appeal'`);
    expect(call.slice(1)).toEqual(expect.arrayContaining([3, 'h-current', MODEL_ID]));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('restores the pre-poi nsfw and sfwOnly from the snapshot', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' });
    const text = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(text).toContain(
      `ELSE COALESCE((m.meta->?->'poi'->'prev'->>'nsfw')::boolean, m.nsfw) END`
    );
    expect(text).toContain(
      `ELSE COALESCE((m.meta->?->'poi'->'prev'->>'sfwOnly')::boolean, m."sfwOnly") END`
    );
  });

  // Review Focus 4.
  it('never re-opens NSFW on a model that is still minor', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' });
    const text = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(text).toContain('nsfw = CASE WHEN m.minor THEN m.nsfw');
    expect(text).toContain(`"sfwOnly" = CASE WHEN m.minor THEN m."sfwOnly"`);
    expect(text).toContain(`WHEN m.minor THEN m."gallerySettings"`);
  });

  it('runs side effects and levels only when a row changed', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' });
    expect(mockSideEffects).toHaveBeenCalledTimes(1);
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);

    vi.clearAllMocks();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(
      await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' })
    ).toBe(false);
    expect(mockSideEffects).not.toHaveBeenCalled();
  });

  it('does nothing for a model that is not poi', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ poi: false }));
    expect(
      await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, currentHash: 'h-current' })
    ).toBe(false);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('stampModelTextScanAppeal', () => {
  it('stamps only the named labels, with the flagged text hash and the current one as fallback', async () => {
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['poi'],
      currentHash: 'h-current',
    });
    const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toContain('unnest(');
    expect(text).toContain(`'textHash', COALESCE(m.meta->?->l.label->>'textHash', ?::text)`);
    expect(text).toContain(`'via', 'appeal'`);
    expect(call.slice(1)).toContainEqual(['poi']);
    expect(call.slice(1)).toEqual(
      expect.arrayContaining(['appealGranted', 3, MODEL_ID, 'h-current'])
    );
  });

  it('writes nothing for an empty label list', async () => {
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealUpheld',
      labels: [],
    });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('reassertModelPoiRestrictions', () => {
  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ poi: true, nsfw: true }));
  });

  it('puts a poi model back to SFW with the poi locks in one guarded write', async () => {
    expect(await reassertModelPoiRestrictions(MODEL_ID)).toBe(true);
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const text = sqlOf(call);
    expect(text).toContain('nsfw = FALSE');
    expect(text).toContain('"sfwOnly" = TRUE');
    expect(text).toMatch(/AND m\.poi\s+AND \(\s+m\.nsfw\s+OR NOT m\."sfwOnly"/);
    expect(call.slice(1)).toContainEqual(POI_LOCKED_PROPERTIES);
    expect(call.slice(1)).toContain(sfwBrowsingLevelsFlag);
    expect(mockSideEffects).toHaveBeenCalledTimes(1);
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
  });

  it('does nothing for a model that is not poi, or already restricted', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ poi: false }));
    expect(await reassertModelPoiRestrictions(MODEL_ID)).toBe(false);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();

    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ poi: true }));
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(await reassertModelPoiRestrictions(MODEL_ID)).toBe(false);
    expect(mockSideEffects).not.toHaveBeenCalled();
  });
});

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { TextScanOutcome } from '~/server/services/text-scan/types';
import type * as LabelCapture from '~/server/services/text-scan/label-capture';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const { mockSetModelMinor, mockSideEffects, mockCreateNotification, entityChangesMock } =
  vi.hoisted(() => ({
    mockSetModelMinor: vi.fn(),
    mockSideEffects: vi.fn(),
    mockCreateNotification: vi.fn(),
    entityChangesMock: vi.fn(),
  }));
const { mockRestoreOwnerFlagOverride } = vi.hoisted(() => ({
  mockRestoreOwnerFlagOverride: vi.fn(),
}));

// Label capture runs on real Postgres in label-capture.rulings.behavior.test.ts; here the flag
// writer runs on the plain client so its own statement can be read.
vi.mock('~/server/services/text-scan/label-capture', async (importOriginal) => {
  const { dbMock } = await import('~/__tests__/mocks/db.mock');
  return {
    ...(await importOriginal<typeof LabelCapture>()),
    writeTextScanRuling: (_ruling: unknown, write: (tx: unknown) => unknown) =>
      write(dbMock.dbWrite),
  };
});
// Hand-listed: the real model.service pulls the whole model graph (meili, prom, redis) at load.
const { mockClearPoiHashMeta } = vi.hoisted(() => ({ mockClearPoiHashMeta: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  setModelMinor: mockSetModelMinor,
  applyModelFlagSideEffects: mockSideEffects,
  clearPoiHashMeta: mockClearPoiHashMeta,
  restoreOwnerFlagOverride: mockRestoreOwnerFlagOverride,
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
// Nested fragments arrive as Sql values; flattening shows the statement Postgres receives.
const flat = (call: unknown[]): unknown[] => {
  const query = Prisma.sql(call[0] as TemplateStringsArray, ...(call.slice(1) as never[]));
  return [query.strings, ...query.values];
};
const sqlOf = (call: unknown[]) => (flat(call)[0] as string[]).join('?');

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
  it('reads nothing when no label is newly detected, and never writes a flag', async () => {
    await run(
      outcome({
        poi: poi({ detected: false, newlyDetected: false, names: [] }),
        minor: minor({ detected: true, declared: true, newlyDetected: false }),
      })
    );
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockSetModelMinor).not.toHaveBeenCalled();
  });

  it('a clean verdict costs one guarded update per label, with no read', async () => {
    await run(outcome({ poi: poi({ detected: false, newlyDetected: false, names: [] }) }));
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const call = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    const text = sqlOf(call);
    expect(text).toContain(`- 'redetected'`);
    expect(text).toContain(`? 'redetected'`);
    expect(text).toContain(`IS DISTINCT FROM`);
    expect(call.slice(1)).toContain(textScanTextHash(SUBJECT));
  });

  it('a detection the owner already declared leaves a pending re-detection alone', async () => {
    await run(outcome({ minor: minor({ detected: true, declared: true, newlyDetected: false }) }));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('never touches poi or minor for an outcome that did not ask for them', async () => {
    await run(outcome({ triggeredLabels: ['nsfw'], nsfwLevel: 16 }));
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

describe('applyModelPoiMinor — the verdict row', () => {
  it('stamps promptIds and model from the row whose workflow produced the verdict', async () => {
    await run(outcome({ poi: poi(), minor: minor() }));
    for (const call of [
      flat(dbMock.dbWrite.$queryRaw.mock.calls[0]),
      flat(dbMock.dbWrite.$executeRaw.mock.calls[0]),
    ]) {
      const text = sqlOf(call);
      expect(text).toContain('em."entityType" = ANY(');
      expect(text).toContain('ORDER BY em."workflowId" = ');
      // A row with a NULL workflowId must not outrank the matching row.
      expect(text).toContain(' DESC NULLS LAST, em."entityType"');
      const values = call.slice(1);
      expect(values).toContainEqual(['Model', 'Model:search']);
      expect(values).toContain('wf-1');
    }
  });
});

describe('applyModelPoiMinor — poi', () => {
  it('sets, restricts and locks in one guarded write that snapshots the pre-flag state', async () => {
    await run(outcome({ poi: poi() }));

    const call = flat(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    const text = sqlOf(call);
    expect(text).toContain('poi = TRUE');
    expect(text).toContain('nsfw = FALSE');
    expect(text).toContain('"sfwOnly" = TRUE');
    expect(text).toContain(`'prev', jsonb_build_object(`);
    expect(text).toContain('FROM "EntityModeration" em');
    expect(text).toContain('NOT m.poi');
    expect(text).toContain(`NOT ('poi' = ANY(`);
    expect(text).toContain(`->'appealGranted' IS NULL`);
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

  it('treats a grant that carries no text hash as covering nothing: a re-detection, not a flag', async () => {
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
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
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

  it('records a re-detection and flags nothing once the text changed after a granted appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({ lockedProperties: ['poi'], meta: granted('poi', textScanTextHash(SUBJECT)) })
    );
    expect(await run(outcome({ poi: poi() }), EDITED)).toEqual({ notified: false });

    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    const write = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    const text = sqlOf(write);
    expect(text).toContain(`'redetected', `);
    expect(text).toContain(`->'appealGranted'->>'textHash' IS DISTINCT FROM `);
    expect(text).not.toContain('poi = TRUE');
    const detection = JSON.parse(
      write.slice(1).find((v) => typeof v === 'string' && v.includes('wf-1')) as string
    );
    expect(detection).toMatchObject({ workflowId: 'wf-1', textHash: textScanTextHash(EDITED) });
    expect(mockSideEffects).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('carries the earlier decisions into the history when a flag replaces the entry', async () => {
    await run(outcome({ poi: poi() }));
    const text = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(text).toContain(`'rulings'`);
    expect(text).toContain(`->'appealGranted') - 'note') || '{"decision":"appealGranted"}'`);
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

    const write = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
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
    expect(text).toContain(`->'appealGranted' IS NULL`);
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

  it('records a minor re-detection and flags nothing once the text changed after a granted appeal', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      storedModel({
        lockedProperties: ['minor'],
        meta: granted('minor', textScanTextHash(SUBJECT)),
      })
    );
    expect(await run(outcome({ minor: minor() }), EDITED)).toEqual({ notified: false });
    const write = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    expect(sqlOf(write)).toContain(`'redetected', `);
    expect(write.slice(1)).toContain(textScanTextHash(EDITED));
    expect(mockSetModelMinor).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
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
      await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' })
    ).toBe(true);
    const text = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(text).toContain('poi = FALSE');
    expect(text).toContain(`ARRAY['poi']::text[]`);
    // nsfw/sfwOnly locks stay while minor holds them, or when they predate the poi flag.
    expect(text).toMatch(
      /WHERE p = 'poi'\s+OR m\.minor\s+OR p NOT IN \('nsfw', 'sfwOnly'\)\s+OR p IN \(SELECT jsonb_array_elements_text\(m\.meta->\?->'poi'->'prev'->'lockedProperties'\)\)/
    );
  });

  // Without the stamp, the hash match re-flags the same file from a seed it shares.
  it('marks the model cleared for the real-person hash match', async () => {
    mockClearPoiHashMeta.mockClear();
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    expect(mockClearPoiHashMeta).toHaveBeenCalledWith(MODEL_ID);
  });

  // An owner's override predates the text-scan flag, so the ruling it replaced goes back on top.
  it("fans out the ruling an owner's override put back", async () => {
    const restored = { nsfw: true, sfwOnly: false, lockedProperties: ['nsfw'] };
    mockRestoreOwnerFlagOverride.mockResolvedValueOnce(restored);
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    expect(mockRestoreOwnerFlagOverride).toHaveBeenCalledWith(MODEL_ID, { revertedFlag: 'poi' });
    expect(mockSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ poi: false, ...restored }) })
    );
  });

  it('marks nothing when nothing was lifted', async () => {
    mockClearPoiHashMeta.mockClear();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    expect(mockClearPoiHashMeta).not.toHaveBeenCalled();
  });

  // A grant recorded apart from the lift would outlive a failed lift, and a recorded grant reads as
  // lifted, so nothing could retry it.
  it('records the appeal grant in the statement that lifts poi', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    const call = flat(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    const text = sqlOf(call);
    expect(text).toMatch(/meta = jsonb_set\(\s+m\.meta,\s+ARRAY\[\?::text, 'poi'\],/);
    expect(text).toContain(`- 'redetected'`);
    expect(text).toContain(`'textHash', ?::text,`);
    expect(call.slice(1)).toEqual(expect.arrayContaining([3, 'h-current', 'appeal', MODEL_ID]));
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('records a moderator lift with its reason and note instead of an appeal', async () => {
    await grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: 'h-current',
      via: 'moderator',
      reason: 'Fictional person',
      note: 'not a real likeness',
    });
    const call = flat(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    const bound = call.slice(1);
    // The statement binds via, reason, note in that order after the hash; a swap would pass a bag check.
    const at = bound.indexOf('moderator');
    expect(at).toBeGreaterThan(-1);
    expect(bound.slice(at, at + 3)).toEqual([
      'moderator',
      'Fictional person',
      'not a real likeness',
    ]);
    expect(bound).not.toContain('appeal');
  });

  it('only lifts the flag whose text hash the caller expects, and not at all without one', async () => {
    await grantModelTextScanPoi({
      modelId: MODEL_ID,
      userId: 3,
      grantHash: 'h-current',
      expectTextHash: 'h-seen',
    });
    const guarded = flat(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(sqlOf(guarded)).toContain(`->'poi')->>'textHash' = ?`);
    expect(guarded.slice(1)).toContain('h-seen');

    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    expect(sqlOf(flat(dbMock.dbWrite.$queryRaw.mock.calls[1]))).not.toContain(`->>'textHash' = ?`);
  });

  it('restores the pre-poi nsfw and sfwOnly from the snapshot', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
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
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    const text = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(text).toContain('nsfw = CASE WHEN m.minor THEN m.nsfw');
    expect(text).toContain(`"sfwOnly" = CASE WHEN m.minor THEN m."sfwOnly"`);
    expect(text).toContain(`WHEN m.minor THEN m."gallerySettings"`);
  });

  it('runs side effects and levels only when a row changed', async () => {
    await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' });
    expect(mockSideEffects).toHaveBeenCalledTimes(1);
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);

    vi.clearAllMocks();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(
      await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' })
    ).toBe(false);
    expect(mockSideEffects).not.toHaveBeenCalled();
  });

  it('does nothing for a model that is not poi', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(storedModel({ poi: false }));
    expect(
      await grantModelTextScanPoi({ modelId: MODEL_ID, userId: 3, grantHash: 'h-current' })
    ).toBe(false);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('stampModelTextScanAppeal', () => {
  it('grants each label against its own hash, not the flagged one, so a verdict for that text cannot re-flag', async () => {
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealGranted',
      labels: ['poi', 'minor'],
      grantHashes: { poi: 'h-main', minor: 'h-search' },
    });
    const call = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    const text = sqlOf(call);
    expect(text).toContain('unnest(');
    expect(text).toContain(
      `'textHash', COALESCE((?::jsonb)->>l.label, m.meta->?->l.label->>'textHash')`
    );
    expect(text).toContain(`'via', ?::text`);
    expect(call.slice(1)).toContain('appeal');
    expect(call.slice(1)).toContainEqual(['poi', 'minor']);
    expect(call.slice(1).map((v) => (typeof v === 'string' ? v : ''))).toContain(
      JSON.stringify({ poi: 'h-main', minor: 'h-search' })
    );
  });

  it('stamps only the flag whose text hash the caller expects and returns the rows it changed', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);
    const changed = await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealUpheld',
      labels: ['poi'],
      expectTextHash: 'h-seen',
    });
    expect(changed).toBe(0);
    const call = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    expect(sqlOf(call)).toContain(`->'poi')->>'textHash' = ?`);
    expect(call.slice(1)).toContain('h-seen');
  });

  it('keeps an upheld ruling on the flagged text', async () => {
    await stampModelTextScanAppeal({
      modelId: MODEL_ID,
      userId: 3,
      decision: 'appealUpheld',
      labels: ['poi'],
      grantHashes: { poi: 'h-main' },
    });
    const call = flat(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    // The hash map is empty for an upheld ruling, so the flagged hash wins.
    expect(call.slice(1)).toContain('{}');
    expect(call.slice(1)).not.toContain(JSON.stringify({ poi: 'h-main' }));
  });

  it.each([
    ['no hashes', undefined],
    ['a hash for only one label', { poi: 'h-main' }],
  ])(
    'refuses a grant with %s instead of falling back to the flagged hash',
    async (_n, grantHashes) => {
      await expect(
        stampModelTextScanAppeal({
          modelId: MODEL_ID,
          userId: 3,
          decision: 'appealGranted',
          labels: ['poi', 'minor'],
          grantHashes,
        })
      ).rejects.toThrow(/grant hash/i);
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    }
  );

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
    const call = flat(dbMock.dbWrite.$queryRaw.mock.calls[0]);
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

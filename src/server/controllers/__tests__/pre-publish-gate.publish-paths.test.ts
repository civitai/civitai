import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as Caches from '~/server/redis/caches';
import type * as SearchIndex from '~/server/search-index';
import type * as Submit from '~/server/services/text-scan/submit';
import type * as RulesHold from '~/server/services/text-scan/model-rules-hold';
import type * as NotificationService from '~/server/services/notification.service';

// Every publish path an owner can take runs the pre-publish gate against the real gate service, fed
// by the db mock: only the publish writes themselves are replaced. Each refusal or hold has a
// control on the same fixture that publishes, so a gate that never runs cannot pass.

const {
  mockPublishModelById,
  mockUnpublishModelById,
  mockPublishPrivateModel,
  mockPublishModelVersionById,
  mockScanEntity,
  mockGetModel,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockGetModel: vi.fn(),
  mockPublishModelById: vi.fn(),
  mockUnpublishModelById: vi.fn(),
  mockPublishPrivateModel: vi.fn(),
  mockPublishModelVersionById: vi.fn(),
  mockScanEntity: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishModelById: mockPublishModelById,
  unpublishModelById: mockUnpublishModelById,
  publishPrivateModel: mockPublishPrivateModel,
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  publishModelVersionById: mockPublishModelVersionById,
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntity: mockScanEntity,
  checkModelRulesInBackground: vi.fn(),
  scanEntityInBackground: vi.fn(),
}));
vi.mock('~/server/services/text-scan/model-rules-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof RulesHold>()),
  checkModelRulesLiteralHold: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: vi.fn() } }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  publishModelHandler,
  publishPrivateModelHandler,
} from '~/server/controllers/model.controller';
import { publishModelVersionHandler } from '~/server/controllers/model-version.controller';

const MODEL_ID = 42;
const VERSION_ID = 100;
const OWNER_ID = 7;
const MOD_ID = 9;
const OTHER_MODELS_VERSION_ID = 999;
const SIBLING_ID = 101;
const FIBO = 'Fibo 2.0';
const UNGATED = 'SDXL 1.0';

type Fixture = {
  baseModel?: string;
  ingestion?: string;
  poi?: boolean;
  textScan?: 'clear' | 'hit' | 'none' | 'stale';
  imagePoi?: boolean;
  status?: string;
  availability?: string;
  /** A gated version carries the needs-review mark of an earlier hold. */
  heldVersion?: boolean;
  /** A moderator declined a held gated version. */
  declinedVersion?: boolean;
  /** The gated version's own status; a private model's versions are Published. */
  versionStatus?: string;
  modelMeta?: Record<string, unknown>;
};

const track = {
  modelEvent: vi.fn().mockResolvedValue(undefined),
  modelVersionEvent: vi.fn().mockResolvedValue(undefined),
};
const user = (isModerator = false) => ({ id: isModerator ? MOD_ID : OWNER_ID, isModerator });

function seed({
  baseModel = FIBO,
  ingestion = 'Scanned',
  poi = false,
  textScan = 'clear',
  status = 'Draft',
  availability = 'Public',
  imagePoi = false,
  heldVersion = false,
  declinedVersion = false,
  modelMeta = {},
  versionStatus = availability === 'Private' ? 'Published' : 'Draft',
}: Fixture = {}) {
  const model = {
    id: MODEL_ID,
    userId: OWNER_ID,
    name: 'A style',
    description: null,
    nsfw: false,
    poi,
    minor: false,
    status,
    availability,
    meta: modelMeta,
    modelVersions: [{ id: VERSION_ID, name: 'v1', description: null, trainedWords: ['style'] }],
  };
  dbMock.dbRead.model.findUnique.mockResolvedValue(model as never);
  mockGetModel.mockResolvedValue(model);
  dbMock.dbWrite.model.findUnique.mockResolvedValue(model as never);
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue(model as never);
  dbMock.dbWrite.model.findMany.mockResolvedValue([model] as never);
  // Evaluates the where clauses the code sends. 101 is an ungated sibling on the same model; 999 is
  // on another owner's model.
  type Where = {
    modelId?: number;
    id?: { in?: number[] };
    status?: string | { in?: string[]; not?: string };
    OR?: Where[];
  };
  const rows = [
    { id: VERSION_ID, modelId: MODEL_ID, baseModel, status: versionStatus },
    { id: SIBLING_ID, modelId: MODEL_ID, baseModel: UNGATED, status: 'Draft' },
    { id: OTHER_MODELS_VERSION_ID, modelId: MODEL_ID + 1, baseModel, status: 'Draft' },
  ];
  const matches = (v: (typeof rows)[number], w: Where): boolean =>
    (w.modelId === undefined || v.modelId === w.modelId) &&
    (!w.id?.in || w.id.in.includes(v.id)) &&
    (w.status === undefined ||
      (typeof w.status === 'string'
        ? v.status === w.status
        : (!w.status.in || w.status.in.includes(v.status)) &&
          (!w.status.not || v.status !== w.status.not))) &&
    (!w.OR || w.OR.some((o) => matches(v, o)));
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async (args: { where?: Where }) =>
    rows
      .filter((v) => matches(v, args?.where ?? {}))
      .map(({ id, baseModel }) => ({
        id,
        name: `v${id}`,
        baseModel,
        meta: declinedVersion && id === VERSION_ID ? { decliendAt: '2026-11-09T00:00:00Z' } : {},
      }))) as never);
  // Only the hold count answers (it asks for either mark); the take-down count stays 0.
  dbMock.dbWrite.modelVersion.count.mockImplementation((async (args: {
    where?: { OR?: { meta?: { path?: string[] } }[] };
  }) => {
    const marks = (args?.where?.OR ?? []).map((c) => c.meta?.path?.[0]);
    if (heldVersion && marks.includes('needsReview')) return 1;
    if (declinedVersion && marks.includes('decliendAt')) return 1;
    return 0;
  }) as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    bannedAt: null,
    deletedAt: null,
    muted: false,
  } as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([
    {
      id: 1,
      ingestion,
      nsfwLevel: ingestion === 'Scanned' ? 1 : 0,
      minor: false,
      poi: imagePoi,
      needsReview: null,
      createdAt: new Date(),
    },
  ] as never);
  // The gate's text scan has answered for this text when the row carries the hash it computes.
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () =>
    textScan === 'none'
      ? null
      : {
          status: 'Succeeded',
          triggeredLabels: textScan === 'hit' ? ['poi'] : [],
          result: { textHash: textScan === 'stale' ? 'text-before-an-edit' : currentTextHash },
        }) as never);
  mockScanEntity.mockResolvedValue({ status: 'submitted', workflowId: 'wf' });
}

let currentTextHash = '';
beforeEach(async () => {
  vi.clearAllMocks();
  const { loadModelPrePublishSubjects } = await import(
    '~/server/services/text-scan/profiles/model-pre-publish.profile'
  );
  const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
  seed();
  currentTextHash = textScanTextHash(
    (await loadModelPrePublishSubjects([MODEL_ID])).get(MODEL_ID)!
  );
  mockPublishModelById.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    modelVersions: [{ id: VERSION_ID }],
  });
  mockPublishModelVersionById.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    model: { nsfw: false },
  });
  mockPublishPrivateModel.mockResolvedValue({ versionIds: [VERSION_ID], held: false });
});

const rawSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map(([strings]) =>
    (strings as TemplateStringsArray).join('?')
  );

/** The model went to a moderator the way every hold must: unpublished with a held gate record. */
const expectModelHeld = () =>
  expect(mockUnpublishModelById).toHaveBeenCalledWith(
    expect.objectContaining({
      id: MODEL_ID,
      metaPatch: expect.objectContaining({
        needsReview: true,
        prePublishGate: expect.objectContaining({ state: 'held' }),
      }),
    })
  );

const loggedRows = () =>
  dbMock.dbWrite.modelPublishCheck.createMany.mock.calls.flatMap(
    ([args]) => (args as { data: Record<string, unknown>[] }).data
  );

const publishModel = (isModerator = false) =>
  publishModelHandler({
    input: { id: MODEL_ID, versionIds: [VERSION_ID] },
    ctx: { user: user(isModerator), track },
  } as never);

describe('model publish', () => {
  it('publishes a FIBO model whose images are scanned and whose text is clear (control)', async () => {
    await publishModel();
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
    // The write refuses any version gated by then that the gate did not judge.
    expect(mockPublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ gateJudgedVersionIds: [VERSION_ID] })
    );
    expect(loggedRows()).toContainEqual(
      expect.objectContaining({ check: 'gate', outcome: 'pass' })
    );
  });

  it('does not publish while a showcase image is unscanned, and says it is checking', async () => {
    seed({ ingestion: 'Pending' });
    await expect(publishModel()).resolves.toMatchObject({ prePublishGate: 'pending' });
    expect(mockPublishModelById).not.toHaveBeenCalled();
    expect(loggedRows()).toContainEqual(
      expect.objectContaining({ check: 'images', outcome: 'pending' })
    );
  });

  it('publishes the same unscanned model on a base model without the gate (control)', async () => {
    seed({ ingestion: 'Pending', baseModel: UNGATED });
    await publishModel();
    expect(mockPublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ gateJudgedVersionIds: [] })
    );
    expect(loggedRows()).toEqual([]);
  });

  it('holds a real-person text hit for a moderator instead of publishing', async () => {
    seed({ textScan: 'hit' });
    await publishModel();
    expect(mockPublishModelById).not.toHaveBeenCalled();
    expectModelHeld();
  });

  it('reads every showcase image of the gated versions with the fields it judges', async () => {
    await publishModel();
    expect(dbMock.dbWrite.image.findMany).toHaveBeenCalledWith({
      where: { post: { modelVersionId: { in: [VERSION_ID] }, userId: OWNER_ID } },
      select: expect.objectContaining({
        ingestion: true,
        nsfwLevel: true,
        minor: true,
        poi: true,
        needsReview: true,
        createdAt: true,
      }),
    });
  });

  it('holds a model whose showcase image is flagged as a real person', async () => {
    seed({ imagePoi: true });
    await publishModel();
    expect(mockPublishModelById).not.toHaveBeenCalled();
    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
    expectModelHeld();
  });

  it('rescans and waits when the text changed since its last scan', async () => {
    seed({ textScan: 'stale' });
    await expect(publishModel()).resolves.toMatchObject({ prePublishGate: 'pending' });
    expect(mockScanEntity).toHaveBeenCalledWith({
      entityType: 'ModelPrePublish',
      entityId: MODEL_ID,
    });
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('holds for a moderator when its text scan cannot run', async () => {
    seed({ textScan: 'none' });
    mockScanEntity.mockResolvedValue({ status: 'skipped', reason: 'off' });
    await publishModel();
    expect(mockPublishModelById).not.toHaveBeenCalled();
    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
    expectModelHeld();
  });

  it('holds a model marked as a real person', async () => {
    seed({ poi: true });
    await publishModel();
    expect(mockPublishModelById).not.toHaveBeenCalled();
    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
    expectModelHeld();
  });

  it('starts its own text scan and waits when the text has not been scanned', async () => {
    seed({ textScan: 'none' });
    await expect(publishModel()).resolves.toMatchObject({ prePublishGate: 'pending' });
    expect(mockScanEntity).toHaveBeenCalledWith({
      entityType: 'ModelPrePublish',
      entityId: MODEL_ID,
    });
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('does not schedule a clean model: it waits, and is checked again at the time picked', async () => {
    const later = new Date(Date.now() + 86_400_000);
    await expect(
      publishModelHandler({
        input: { id: MODEL_ID, versionIds: [VERSION_ID], publishedAt: later },
        ctx: { user: user(), track },
      } as never)
    ).resolves.toMatchObject({ prePublishGate: 'pending' });
    expect(mockPublishModelById).not.toHaveBeenCalled();
    // The row the resolver's queue looks for, so it is checked again at that time.
    expect(loggedRows()).toContainEqual(
      expect.objectContaining({ check: 'gate', outcome: 'pass', detail: { scheduled: true } })
    );
  });

  it('publishes at once when the time picked has passed (control)', async () => {
    await publishModelHandler({
      input: { id: MODEL_ID, versionIds: [VERSION_ID], publishedAt: new Date(Date.now() - 1000) },
      ctx: { user: user(), track },
    } as never);
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it('refuses model.publish of a model whose version a moderator holds, even when it is now clean', async () => {
    seed({ status: 'Unpublished', heldVersion: true });
    await expect(publishModel()).rejects.toThrow(/waiting for a review/);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('publishes the same unpublished model when no version is held (control)', async () => {
    seed({ status: 'Unpublished' });
    await publishModel();
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it('checks a published FIBO version that goes public with its model, though only a sibling is listed', async () => {
    seed({ ingestion: 'Pending', versionStatus: 'Published' });
    await expect(
      publishModelHandler({
        input: { id: MODEL_ID, versionIds: [SIBLING_ID] },
        ctx: { user: user(), track },
      } as never)
    ).resolves.toMatchObject({ prePublishGate: 'pending' });
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('publishes the sibling alone when the FIBO version stays a draft (control)', async () => {
    seed({ ingestion: 'Pending' });
    await publishModelHandler({
      input: { id: MODEL_ID, versionIds: [SIBLING_ID] },
      ctx: { user: user(), track },
    } as never);
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it('refuses a failed image scan with the owner message', async () => {
    seed({ ingestion: 'Error' });
    await expect(publishModel()).rejects.toThrow(/Re-upload or remove/);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('fails closed: an error inside the gate leaves the model unpublished', async () => {
    dbMock.dbWrite.image.findMany.mockRejectedValue(new Error('db down'));
    await expect(publishModel()).rejects.toThrow(/db down/);
    expect(mockPublishModelById).not.toHaveBeenCalled();
  });

  it('lets a moderator publish ungated and logs the release with the moderator', async () => {
    seed({ ingestion: 'Pending', textScan: 'hit' });
    await publishModel(true);
    expect(mockPublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ gateJudgedVersionIds: undefined })
    );
    expect(loggedRows()).toEqual([
      expect.objectContaining({
        modelId: MODEL_ID,
        modelVersionId: VERSION_ID,
        check: 'moderator_release',
        outcome: 'released',
        actorId: MOD_ID,
      }),
    ]);
  });
});

describe('private to public', () => {
  const publishPrivate = () =>
    publishPrivateModelHandler({
      input: { modelId: MODEL_ID, publishVersions: true },
      ctx: { user: user() },
    } as never);

  it('does not make a private FIBO model public while an image is unscanned', async () => {
    seed({ ingestion: 'Pending', status: 'Published', availability: 'Private' });
    await expect(publishPrivate()).resolves.toMatchObject({ prePublishGate: 'pending' });
    expect(mockPublishPrivateModel).not.toHaveBeenCalled();
  });

  it('keeps a private model with a real-person hit private, in the moderator queue', async () => {
    seed({ textScan: 'hit', status: 'Published', availability: 'Private' });
    await expect(publishPrivate()).resolves.toMatchObject({ held: true, prePublishGate: 'held' });
    expect(mockPublishPrivateModel).not.toHaveBeenCalled();
    // Not unpublished: its owner keeps using it privately while it waits.
    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(rawSql()).toContainEqual(
      expect.stringMatching(/UPDATE "Model"[\s\S]*'needsReview', true, 'prePublishHold', true/)
    );
  });

  it('refuses the owner a second try while a moderator has it, whatever a later run recorded', async () => {
    // A later gate run (a new version, say) replaced the run record; the hold mark stays.
    seed({
      status: 'Published',
      availability: 'Private',
      modelMeta: { needsReview: true, prePublishHold: true, prePublishGate: { state: 'passed' } },
    });
    await expect(publishPrivate()).rejects.toThrow(/waiting for a review/);
    expect(mockPublishPrivateModel).not.toHaveBeenCalled();
  });

  it('keeps a held private model private even once no version is on FIBO', async () => {
    seed({
      baseModel: UNGATED,
      status: 'Published',
      availability: 'Private',
      modelMeta: { needsReview: true, prePublishHold: true },
    });
    await expect(publishPrivate()).rejects.toThrow(/waiting for a review/);
    expect(mockPublishPrivateModel).not.toHaveBeenCalled();
  });

  it('ends a private hold when a moderator makes it public, even with no FIBO version left', async () => {
    seed({
      baseModel: UNGATED,
      status: 'Published',
      availability: 'Private',
      modelMeta: { needsReview: true, prePublishHold: true },
    });
    await publishPrivateModelHandler({
      input: { modelId: MODEL_ID, publishVersions: true },
      ctx: { user: user(true) },
    } as never);
    expect(mockPublishPrivateModel).toHaveBeenCalledTimes(1);
    expect(rawSql()).toContainEqual(
      expect.stringMatching(/UPDATE "Model"[\s\S]* - 'needsReview' - 'prePublishHold'/)
    );
  });

  it('does not end a private hold when a moderator publishes only one version', async () => {
    seed({
      status: 'Published',
      availability: 'Private',
      modelMeta: { needsReview: true, prePublishHold: true },
    });
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      meta: {},
      status: 'Draft',
      modelId: MODEL_ID,
      baseModel: FIBO,
      model: {
        userId: OWNER_ID,
        nsfw: false,
        status: 'Published',
        availability: 'Private',
        meta: {},
      },
    } as never);
    await publishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user: user(true), track },
    } as never);
    expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
    expect(rawSql()).not.toContainEqual(expect.stringMatching(/'prePublishHold'/));
  });

  it('tells the owner a moderator declined a held private model', async () => {
    seed({
      status: 'Published',
      availability: 'Private',
      // A decline without a reason still records its time.
      modelMeta: { prePublishHold: true, declinedAt: '2026-11-09T00:00:00Z', needsReview: false },
    });
    await expect(publishPrivate()).rejects.toThrow(/declined to make this model public/);
    expect(mockPublishPrivateModel).not.toHaveBeenCalled();
  });

  it('makes it public once the checks pass (control)', async () => {
    seed({ status: 'Published', availability: 'Private' });
    await publishPrivate();
    expect(mockPublishPrivateModel).toHaveBeenCalledTimes(1);
    // The write refuses any version gated by then that the gate did not judge.
    expect(mockPublishPrivateModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gateJudgedVersionIds: [VERSION_ID] })
    );
  });
});

describe('new version on a live model', () => {
  const publishVersion = () =>
    publishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user: user(), track },
    } as never);
  const live = { status: 'Published', availability: 'Public' };

  beforeEach(() => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      meta: {},
      status: 'Draft',
      modelId: MODEL_ID,
      baseModel: FIBO,
      model: { userId: OWNER_ID, nsfw: false, ...live, meta: {} },
    } as never);
  });

  // An unpublished version is not live, so its owner may change its files; publishing it again
  // runs the gate again, as for a new version.
  describe('republishing a version its owner unpublished', () => {
    beforeEach(() => {
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
        meta: {},
        status: 'Unpublished',
        modelId: MODEL_ID,
        baseModel: FIBO,
        model: { userId: OWNER_ID, nsfw: false, ...live, meta: {} },
      } as never);
    });

    it('runs the gate again and waits while an image is unscanned', async () => {
      seed({ ingestion: 'Pending', ...live, versionStatus: 'Unpublished' });
      await expect(publishVersion()).resolves.toMatchObject({
        held: true,
        prePublishGate: 'pending',
      });
      expect(mockPublishModelVersionById).not.toHaveBeenCalled();
      expect(loggedRows()).toContainEqual(
        expect.objectContaining({ check: 'gate', outcome: 'pending' })
      );
    });

    it('publishes it once the gate passes again (control)', async () => {
      seed({ ...live, versionStatus: 'Unpublished' });
      await publishVersion();
      expect(loggedRows()).toContainEqual(
        expect.objectContaining({ check: 'gate', outcome: 'pass' })
      );
      expect(mockPublishModelVersionById).toHaveBeenCalledWith(
        expect.objectContaining({ republishing: true, gateJudgedVersionIds: [VERSION_ID] })
      );
    });
  });

  it('does not publish a FIBO version while its images are unscanned', async () => {
    seed({ ingestion: 'Pending', ...live });
    await expect(publishVersion()).resolves.toMatchObject({
      held: true,
      prePublishGate: 'pending',
    });
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
  });

  it('keeps a held version with the moderator: the owner cannot publish it again', async () => {
    seed({ ...live, heldVersion: true });
    await expect(publishVersion()).rejects.toThrow(/waiting for a review/);
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
  });

  it('keeps a version a moderator declined with the moderator: the owner cannot retry it', async () => {
    seed({ ...live, declinedVersion: true });
    await expect(publishVersion()).rejects.toThrow(/waiting for a review/);
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
  });

  it('holds only the new version, leaving the live model up, on a real-person hit', async () => {
    seed({ textScan: 'hit', ...live });
    await expect(publishVersion()).resolves.toMatchObject({ prePublishGate: 'held' });
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    // The version goes to the moderator's needs-review queue.
    const sql = dbMock.dbWrite.$executeRaw.mock.calls.map(([strings, ...values]) => ({
      text: (strings as TemplateStringsArray).join('?'),
      values,
    }));
    expect(sql).toContainEqual({
      text: expect.stringMatching(
        /UPDATE "ModelVersion"[\s\S]*'\{"needsReview": true\}'::jsonb[\s\S]*"modelId" = \?/
      ),
      values: [expect.anything(), expect.objectContaining({ values: [VERSION_ID] }), MODEL_ID],
    });
  });

  it('ends a decline when a moderator releases the version, and logs the decline it overrode', async () => {
    seed({ ...live, declinedVersion: true });
    await publishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user: user(true), track },
    } as never);
    expect(loggedRows()).toEqual([
      expect.objectContaining({
        check: 'moderator_release',
        detail: { overrodeDecline: { reason: null, at: '2026-11-09T00:00:00Z' } },
      }),
    ]);
    expect(rawSql()).toContainEqual(
      expect.stringMatching(
        /UPDATE "ModelVersion"[\s\S]*- 'needsReview' - 'declinedReason' - 'decliendAt'/
      )
    );
  });

  it("still runs the publish's side effects when recording the release fails", async () => {
    const { queueModelEarlyAccessReindex } = await import('~/server/services/model.service');
    seed({ textScan: 'hit', ...live });
    dbMock.dbWrite.modelPublishCheck.createMany.mockRejectedValueOnce(new Error('db down'));
    await expect(
      publishModelVersionHandler({
        input: { id: VERSION_ID },
        ctx: { user: user(true), track },
      } as never)
    ).resolves.toBeDefined();
    expect(dbMock.dbWrite.modelPublishCheck.createMany).toHaveBeenCalled();
    expect(queueModelEarlyAccessReindex).toHaveBeenCalledWith({ id: MODEL_ID });
  });

  it('lets a moderator publish the version ungated and logs the release', async () => {
    seed({ textScan: 'hit', ...live });
    await publishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user: user(true), track },
    } as never);
    expect(mockPublishModelVersionById).toHaveBeenCalledWith(
      expect.objectContaining({ gateJudgedVersionIds: undefined })
    );
    expect(loggedRows()).toEqual([
      expect.objectContaining({ check: 'moderator_release', outcome: 'released', actorId: MOD_ID }),
    ]);
  });

  describe('while an earlier publish of the model waits for its checks', () => {
    const waitingRun = (state: string, publishedAt?: Date) => ({
      prePublishGate: {
        state,
        runId: 'run-a',
        scope: 'version',
        versionIds: [SIBLING_ID],
        requestedAt: '2026-11-09T00:00:00.000Z',
        ...(publishedAt
          ? { publishedAt: publishedAt.toISOString(), publishedAtMs: publishedAt.getTime() }
          : {}),
      },
    });
    const gateWrites = () => rawSql().filter((sql) => sql.includes('prePublishGate'));

    it('refuses a second gated publish, naming the waiting version, and leaves its run alone', async () => {
      seed({ ...live, modelMeta: waitingRun('pending') });
      await expect(publishVersion()).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining('"v101" is waiting for its checks'),
      });
      expect(mockPublishModelVersionById).not.toHaveBeenCalled();
      expect(gateWrites()).toEqual([]);
      expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
    });

    it('lets the owner replace an earlier publish that waits for a later date', async () => {
      seed({ ...live, modelMeta: waitingRun('pending', new Date(Date.now() + 86_400_000)) });
      await publishVersion();
      expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
    });

    it('publishes it once the earlier run has ended (control)', async () => {
      seed({ ...live, modelMeta: waitingRun('passed') });
      await publishVersion();
      expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
      expect(gateWrites()).not.toEqual([]);
    });
  });

  it('publishes it once the checks pass (control)', async () => {
    seed(live);
    await publishVersion();
    expect(mockPublishModelVersionById).toHaveBeenCalledWith(
      expect.objectContaining({ gateJudgedVersionIds: [VERSION_ID] })
    );
  });
});

describe('resolver', () => {
  it('publishes a waiting model once its image is scanned, in the same logged run', async () => {
    const { resolveWaitingGate } = await import('~/server/jobs/resolve-pre-publish-gates');
    seed({ ingestion: 'Pending' });
    await publishModel();
    expect(mockPublishModelById).not.toHaveBeenCalled();
    const runId = loggedRows()[0].runId as string;

    seed();
    await resolveWaitingGate(
      {
        id: MODEL_ID,
        userId: OWNER_ID,
        gate: {
          state: 'pending',
          runId,
          scope: 'model',
          versionIds: [VERSION_ID],
          requestedAt: new Date().toISOString(),
        },
      },
      track as never
    );

    expect(mockPublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODEL_ID, versionIds: [VERSION_ID], enforceModelRules: true })
    );
    expect(new Set(loggedRows().map((r) => r.runId))).toEqual(new Set([runId]));
    expect(loggedRows()).toContainEqual(
      expect.objectContaining({ check: 'gate', outcome: 'pass' })
    );
  });
});

describe('resolver, ending a waiting run the owner was told would publish', () => {
  const waitingRun = {
    state: 'pending' as const,
    runId: 'run-a',
    scope: 'version' as const,
    versionIds: [VERSION_ID],
    requestedAt: '2026-11-09T00:00:00.000Z',
  };
  const resolve = async () => {
    const { resolveWaitingGate } = await import('~/server/jobs/resolve-pre-publish-gates');
    return resolveWaitingGate({ id: MODEL_ID, userId: OWNER_ID, gate: waitingRun }, track as never);
  };
  const told = (details: Record<string, unknown>) =>
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER_ID,
        type: 'pre-publish-gate-result',
        key: 'pre-publish-gate-result:run-a',
        details: expect.objectContaining({ modelId: MODEL_ID, ...details }),
      })
    );
  /** The version to publish, on a model that is live or still a draft. */
  const version = (model: Record<string, unknown>) =>
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      meta: {},
      status: 'Draft',
      modelId: MODEL_ID,
      baseModel: FIBO,
      model: { userId: OWNER_ID, nsfw: false, meta: {}, ...model },
    } as never);
  const live = { status: 'Published', availability: 'Public' };

  it('tells the owner, once, with the refusal they would have seen', async () => {
    version(live);
    seed({ ingestion: 'Blocked', ...live, modelMeta: { prePublishGate: waitingRun } });
    await expect(resolve()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    told({ outcome: 'refused', refusal: 'images' });

    // A second pass over the run it ended (now refused) tells no one again.
    seed({
      ingestion: 'Blocked',
      ...live,
      modelMeta: { prePublishGate: { ...waitingRun, state: 'refused' } },
    });
    await expect(resolve()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('tells the owner when only the new version on a live model goes to a moderator', async () => {
    version(live);
    seed({ textScan: 'hit', ...live, modelMeta: { prePublishGate: waitingRun } });
    await resolve();
    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    told({ outcome: 'held' });
  });

  it('leaves the telling to the take-down when the model itself is held', async () => {
    version({ status: 'Draft', availability: 'Public' });
    seed({ textScan: 'hit', modelMeta: { prePublishGate: waitingRun } });
    await resolve();
    expectModelHeld();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('tells no one when the owner is refused at publish, who sees it there (control)', async () => {
    version(live);
    seed({ ingestion: 'Blocked', ...live });
    await expect(
      publishModelVersionHandler({
        input: { id: VERSION_ID },
        ctx: { user: user(), track },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('resolver, re-checking a run that has failed before', () => {
  it('keeps the count of failed passes, so a run that keeps failing still ends', async () => {
    const { resolveWaitingGate } = await import('~/server/jobs/resolve-pre-publish-gates');
    const gate = {
      state: 'pending' as const,
      runId: 'run-a',
      scope: 'model' as const,
      versionIds: [VERSION_ID],
      requestedAt: '2026-11-09T00:00:00.000Z',
      attempts: 3,
    };
    seed({ modelMeta: { prePublishGate: gate } });
    await resolveWaitingGate({ id: MODEL_ID, userId: OWNER_ID, gate }, track as never);
    const written = dbMock.dbWrite.$executeRaw.mock.calls
      .flatMap(([, ...values]) => values)
      .filter((v): v is string => typeof v === 'string' && v.includes('"runId":"run-a"'))
      .map((v) => JSON.parse(v) as Record<string, unknown>);
    expect(written).toContainEqual(expect.objectContaining({ state: 'passed', attempts: 3 }));
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });
});

describe('resolver, against a forged or stale waiting run', () => {
  const waiting = (gate: Record<string, unknown>) => ({
    id: MODEL_ID,
    userId: OWNER_ID,
    gate: {
      state: 'pending',
      runId: 'run-1',
      scope: 'version',
      versionIds: [VERSION_ID],
      requestedAt: new Date().toISOString(),
      ...gate,
    } as never,
  });
  const closed = () =>
    dbMock.dbWrite.$executeRaw.mock.calls.some(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('"refused"')
    );
  const resolve = async (gate: Record<string, unknown>) => {
    const { resolveWaitingGate } = await import('~/server/jobs/resolve-pre-publish-gates');
    return resolveWaitingGate(waiting(gate), track as never);
  };

  it('never asks for a version of another model, and ends the run', async () => {
    seed({ status: 'Published' });
    await resolve({ versionIds: [OTHER_MODELS_VERSION_ID] });
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
    expect(closed()).toBe(true);
  });

  it('publishes the version of its own model (control)', async () => {
    seed({ status: 'Published' });
    await resolve({});
    expect(mockPublishModelVersionById).toHaveBeenCalledTimes(1);
  });

  it('asks again exactly as the owner did: a model publish that listed no versions lists none', async () => {
    seed();
    await resolve({ scope: 'model', versionIds: [] });
    expect(mockPublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODEL_ID, versionIds: undefined })
    );
  });

  it('does not publish for an owner banned since the ask, and ends the run', async () => {
    seed({ status: 'Published' });
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      bannedAt: new Date(),
      deletedAt: null,
      muted: false,
    } as never);
    await resolve({});
    expect(mockPublishModelVersionById).not.toHaveBeenCalled();
    expect(closed()).toBe(true);
  });
});

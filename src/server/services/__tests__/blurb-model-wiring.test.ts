import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ModelModerationAdapter from '~/server/services/model-moderation.adapter';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as AutoNsfw from '~/server/services/auto-nsfw';

// The Model half of the blurb save path, run against the REAL `upsertModel` /
// `applyModelContentChange`. Only the blurb modules, the blocklist guard and the Redis-backed
// post-commit helpers are stubbed — with no live Redis those awaits never settle and the tests
// hang.
//
// Hoisted: model.service imports every module mocked below, so these factories run while this
// file's own imports are still resolving.
const {
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
  throwOnBlockedLinkDomain,
  submitModelTextModeration,
  preventReplicationLag,
  evaluateAutoNsfw,
} = vi.hoisted(() => ({
  expandBlurbs: vi.fn(),
  getReferencedBlurbIds: vi.fn(),
  reconcileBlurbReferences: vi.fn(),
  throwOnBlockedLinkDomain: vi.fn(),
  submitModelTextModeration: vi.fn(),
  preventReplicationLag: vi.fn(async () => undefined),
  evaluateAutoNsfw: vi.fn(),
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain,
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
}));
vi.mock('~/server/services/model-moderation.adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelModerationAdapter>()),
  submitModelTextModeration,
}));
vi.mock('~/server/services/auto-nsfw', async (importOriginal) => ({
  ...(await importOriginal<typeof AutoNsfw>()),
  evaluateAutoNsfw,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustPublicModelResponseCache: vi.fn(async () => undefined),
  bustMvCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userModelCountCache: { ...actual.userModelCountCache, refresh: vi.fn(async () => undefined) },
    modelTagCache: { ...actual.modelTagCache, refresh: vi.fn(async () => undefined) },
    modelVotableTagsCache: { ...actual.modelVotableTagsCache, bust: vi.fn(async () => undefined) },
  };
});

import { applyModelContentChange, upsertModel } from '~/server/services/model.service';

const MODEL_ID = 51;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

const CLIENT_HTML = '<div data-type="blurb" data-id="7">ATTACKER SUPPLIED</div>';
const EXPANDED_HTML = '<div data-type="blurb" data-id="7">REAL</div>';
const USES = [{ blurbId: 7, contentHash: 'h7' }];

const storedModel = {
  name: 'Stored name',
  description: 'stored description',
  poi: false,
  userId: OWNER_ID,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  lockedProperties: [],
  gallerySettings: {},
  meta: {},
  availability: 'Public',
  mode: null,
  allowNoCredit: true,
  allowCommercialUse: [],
  allowDerivatives: true,
  allowDifferentLicense: true,
  type: 'Checkpoint',
  uploadType: 'Created',
};

const upsert = (input: Record<string, unknown> = {}) =>
  upsertModel({
    id: MODEL_ID,
    userId: OWNER_ID,
    name: 'A model',
    description: CLIENT_HTML,
    type: 'Checkpoint',
    uploadType: 'Created',
    status: 'Draft',
    ...input,
  } as never);

/** The `$executeRaw` templates that write the description column, joined into readable SQL. */
function descriptionSql() {
  return dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings]) => (strings as string[]).join('?'))
    .filter((sql) => /UPDATE "Model"\s+SET description =/.test(sql));
}

beforeEach(() => {
  vi.clearAllMocks();
  expandBlurbs.mockResolvedValue({ evaluated: true, html: EXPANDED_HTML, uses: USES });
  getReferencedBlurbIds.mockResolvedValue([7]);
  reconcileBlurbReferences.mockResolvedValue(undefined);
  throwOnBlockedLinkDomain.mockResolvedValue(undefined);
  submitModelTextModeration.mockResolvedValue(undefined);
  dbMock.dbRead.model.findUnique.mockResolvedValue(storedModel);
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    name: storedModel.name,
    nsfw: false,
    lockedProperties: [],
    meta: null,
  });
  evaluateAutoNsfw.mockReturnValue(null);
  dbMock.dbWrite.model.update.mockResolvedValue({
    id: MODEL_ID,
    name: 'A model',
    description: EXPANDED_HTML,
    nsfwLevel: 1,
    meta: {},
    availability: 'Public',
    userId: OWNER_ID,
    poi: false,
    minor: false,
    sfwOnly: false,
    nsfw: false,
    status: 'Draft',
    type: 'Checkpoint',
  });
  dbMock.dbWrite.model.create.mockResolvedValue({
    id: MODEL_ID,
    nsfwLevel: 1,
    meta: {},
    availability: 'Public',
  });
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('upsertModel — blurb expansion', () => {
  it('stores what the blurb says, not the html the client sent', async () => {
    await upsert();

    const { data } = dbMock.dbWrite.model.update.mock.calls[0][0];
    expect(data.description).toBe(EXPANDED_HTML);
    expect(data.description).not.toContain('ATTACKER SUPPLIED');
  });

  it('re-checks blocked link domains against the EXPANDED html', async () => {
    await upsert();

    // The first guard saw the client's html. Drop the `data.description = expansion.html`
    // assignment and the re-check runs against the same unexpanded string, so a blocked domain
    // that arrived inside the blurb body is never seen.
    const checked = throwOnBlockedLinkDomain.mock.calls.map(([html]) => html);
    expect(checked.slice(0, 2)).toEqual([CLIENT_HTML, EXPANDED_HTML]);
  });

  it('expands against the owner, not the moderator doing the saving', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true });

    // A moderator's own blurb set resolves none of the owner's `data-id`s, so every span would be
    // unwrapped to plain text — a silent, permanent loss of the model's blurbs.
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER_ID, html: CLIENT_HTML })
    );
  });

  it('resolves only the blurbs the model already references when a moderator saves', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true });

    expect(getReferencedBlurbIds).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: MODEL_ID,
    });
    expect(expandBlurbs).toHaveBeenCalledWith(expect.objectContaining({ restrictToBlurbIds: [7] }));
  });

  it('leaves the owner unrestricted', async () => {
    await upsert();

    expect(getReferencedBlurbIds).not.toHaveBeenCalled();
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToBlurbIds: undefined })
    );
  });

  it('stores the expanded html on a create too', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(null);

    await upsert({ id: undefined });

    expect(dbMock.dbWrite.model.create.mock.calls[0][0].data.description).toBe(EXPANDED_HTML);
  });
});

describe('upsertModel — blurb reconciliation', () => {
  it('reconciles after the write, against the model id', async () => {
    await upsert();

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: MODEL_ID,
      uses: USES,
    });

    const [write] = dbMock.dbWrite.model.update.mock.invocationCallOrder;
    const [reconcile] = reconcileBlurbReferences.mock.invocationCallOrder;
    expect(reconcile).toBeGreaterThan(write);
  });

  it('leaves an existing reference row alone when the flag is off for the owner', async () => {
    // Reconciling on an unevaluated expansion deletes EVERY reference row for the model, and the
    // fan-out — deliberately ungated so it can still maintain them — then has nothing left.
    expandBlurbs.mockResolvedValue({ evaluated: false, html: CLIENT_HTML });

    await upsert();

    expect(reconcileBlurbReferences).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model.update).toHaveBeenCalled();
  });

  it('🔴 reconciles on the CREATE path too, against the id it was created with', async () => {
    // The create branch has its own reconcile call, and only the update branch was covered. A
    // blurb inserted while creating a model would get no reference row at all, so the fan-out
    // would never maintain it — frozen at its creation-time text, silently, forever.
    await upsert({ id: undefined });

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: MODEL_ID,
      uses: USES,
    });
  });
});

describe('applyModelContentChange', () => {
  it('writes the description column and nothing else', async () => {
    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });

    // The fan-out calls this with nothing but new HTML. Route it back through the form-shaped
    // upsert and the failure mode is silent field loss — tags, gallery settings and the whole
    // licensing block cleared on every model the job touches.
    const [sql, ...extra] = descriptionSql();
    expect(extra).toEqual([]);
    expect(sql).toMatch(/WHERE id =/);
    expect(sql).not.toMatch(/name|tags|nsfw|status|poi/);
  });

  it('writes through raw SQL so a re-materialization does not bump updatedAt', async () => {
    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });

    // `Model.updatedAt` orders the site-wide "Recently Updated" lists, so a Prisma update here
    // reorders them on every blurb edit any creator makes.
    expect(descriptionSql()).toHaveLength(1);
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('skips the column write when the caller already committed it', async () => {
    // `upsertModel` passes its post-write snapshot. Delete that and this replays the body over a
    // save that committed in between.
    await applyModelContentChange({
      id: MODEL_ID,
      description: EXPANDED_HTML,
      context: { name: 'A model' },
    });

    expect(descriptionSql()).toEqual([]);
  });

  it('rejects a blocked link domain before writing anything', async () => {
    throwOnBlockedLinkDomain.mockRejectedValue(new Error('invalid urls: blocked.example'));

    await expect(
      applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML })
    ).rejects.toThrow('invalid urls');

    expect(descriptionSql()).toEqual([]);
  });

  it('runs the follow-up work a content change implies', async () => {
    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });

    expect(submitModelTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODEL_ID, description: EXPANDED_HTML })
    );
  });
});

// The bypass this closes: `upsertModel` evaluates the text a creator types, but the fan-out
// rewrites an already-published description with text that gate never saw. Publish clean, then
// edit the blurb, and the model keeps the rating it earned with the old words.
describe('applyModelContentChange — the auto-NSFW gate', () => {
  const FLAGGED = {
    metaPatch: { profanityMatches: ['x'], profanityEvaluation: { reason: 'r', metrics: {} } },
    lock: true,
  };

  it('🔴 evaluates the text it just wrote', async () => {
    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });

    expect(evaluateAutoNsfw).toHaveBeenCalledWith({
      name: storedModel.name,
      description: EXPANDED_HTML,
      alreadyNsfw: false,
      lockedProperties: [],
    });
  });

  it('🔴 marks the model nsfw and locks it when the gate fires', async () => {
    evaluateAutoNsfw.mockReturnValue(FLAGGED);

    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });

    const [{ data }] = dbMock.dbWrite.model.update.mock.calls[0];
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
    expect(data.meta).toMatchObject({ profanityMatches: ['x'] });
  });

  it('records the detection but never overturns a moderator lock', async () => {
    evaluateAutoNsfw.mockReturnValue({ ...FLAGGED, lock: false });

    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });

    const [{ data }] = dbMock.dbWrite.model.update.mock.calls[0];
    expect(data.nsfw).toBeUndefined();
    expect(data.lockedProperties).toBeUndefined();
    expect(data.meta).toMatchObject({ profanityMatches: ['x'] });
  });

  it('writes nothing when the gate does not fire', async () => {
    await applyModelContentChange({ id: MODEL_ID, description: EXPANDED_HTML });
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  it('does not re-run on the caller-committed path, which already gated', async () => {
    evaluateAutoNsfw.mockReturnValue(FLAGGED);

    await applyModelContentChange({
      id: MODEL_ID,
      description: EXPANDED_HTML,
      context: { name: storedModel.name },
    });

    expect(evaluateAutoNsfw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });
});

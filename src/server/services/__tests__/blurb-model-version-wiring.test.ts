import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';

// The ModelVersion half of the blurb save path, run against the REAL `upsertModelVersion` /
// `applyModelVersionContentChange`. Only the blurb modules, the blocklist guard and the
// post-commit helpers are stubbed.
//
// Hoisted: model-version.service imports every module mocked below, so these factories run while
// this file's own imports are still resolving.
const {
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
  throwOnBlockedUserContent,
  preventModelVersionLagBatch,
  refreshDataForModelsCache,
} = vi.hoisted(() => ({
  expandBlurbs: vi.fn(),
  getReferencedBlurbIds: vi.fn(),
  reconcileBlurbReferences: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
  preventModelVersionLagBatch: vi.fn(async () => undefined),
  refreshDataForModelsCache: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent,
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    dataForModelsCache: { ...actual.dataForModelsCache, refresh: refreshDataForModelsCache },
  };
});
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventModelVersionLagBatch,
}));

import {
  applyModelVersionContentChange,
  upsertModelVersion,
} from '~/server/services/model-version.service';

const MODEL_ID = 61;
const VERSION_ID = 62;
const CREATED_ID = 63;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

const CLIENT_HTML = '<div data-type="blurb" data-id="7">ATTACKER SUPPLIED</div>';
const EXPANDED_HTML = '<div data-type="blurb" data-id="7">REAL</div>';
const USES = [{ blurbId: 7, contentHash: 'h7' }];

const upsert = (input: Record<string, unknown> = {}) =>
  upsertModelVersion({
    id: VERSION_ID,
    modelId: MODEL_ID,
    name: 'v1',
    baseModel: 'SD 1.5',
    description: CLIENT_HTML,
    trainedWords: [],
    ...input,
  } as never);

/** The `$executeRaw` templates that write the description column, joined into readable SQL. */
function descriptionSql() {
  return dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings]) => (strings as string[]).join('?'))
    .filter((sql) => /UPDATE "ModelVersion"\s+SET description =/.test(sql));
}

const storedVersion = {
  id: VERSION_ID,
  status: 'Draft',
  description: 'stored description',
  trainedWords: [],
  publishedAt: null,
  meta: {},
  baseModel: 'SD 1.5',
  usageControl: 'Download',
  flags: 0,
  licensingFee: null,
  model: { meta: {} },
  monetization: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  expandBlurbs.mockResolvedValue({ evaluated: true, html: EXPANDED_HTML, uses: USES });
  getReferencedBlurbIds.mockResolvedValue([7]);
  reconcileBlurbReferences.mockResolvedValue(undefined);
  throwOnBlockedUserContent.mockResolvedValue(undefined);
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    nsfw: false,
    meta: {},
    userId: OWNER_ID,
    poi: false,
    availability: 'Public',
  });
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue(storedVersion);
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({ modelId: MODEL_ID });
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    description: EXPANDED_HTML,
    status: 'Draft',
    meta: {},
  });
  dbMock.dbWrite.modelVersion.create.mockResolvedValue({
    id: CREATED_ID,
    modelId: MODEL_ID,
    description: EXPANDED_HTML,
    status: 'Draft',
    meta: {},
  });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

/**
 * The guard takes one value or several — a title alongside a body — so a call's checked text is a
 * list. Flattened here rather than indexed, so an assertion below says WHICH text was checked
 * without also pinning how many fields the call happens to bundle.
 */
const checkedTexts = () =>
  throwOnBlockedUserContent.mock.calls.map(([value]: [string | string[]]) =>
    Array.isArray(value) ? value : [value]
  );

describe('upsertModelVersion — blurb expansion', () => {
  it('stores what the blurb says, not the html the client sent', async () => {
    await upsert();

    const { data } = dbMock.dbWrite.modelVersion.update.mock.calls[0][0];
    expect(data.description).toBe(EXPANDED_HTML);
    expect(data.description).not.toContain('ATTACKER SUPPLIED');
  });

  it('re-checks blocked link domains against the EXPANDED html', async () => {
    await upsert();

    // The first guard saw the client's html. Drop the `data.description = expansion.html`
    // assignment and the re-check runs against the same unexpanded string, so a blocked domain
    // that arrived inside the blurb body is never seen.
    const checked = checkedTexts();
    expect(checked[0]).toContain(CLIENT_HTML);
    expect(checked[1]).toEqual([EXPANDED_HTML]);
  });

  it('expands against the owner, not the moderator doing the saving', async () => {
    await upsert({ actorUserId: MODERATOR_ID, isModerator: true });

    // A moderator's own blurb set resolves none of the owner's `data-id`s, so every span would be
    // unwrapped to plain text — a silent, permanent loss of the version's blurbs.
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER_ID, html: CLIENT_HTML })
    );
  });

  it('resolves only the blurbs the version already references when a moderator saves', async () => {
    await upsert({ actorUserId: MODERATOR_ID, isModerator: true });

    // Handed over as a RESOLVER, not an awaited array. `expandBlurbs` owns the flag gate and the
    // has-spans check, so resolving the set before it is called reads BlurbReference on saves
    // where the feature is off or no blurb is named.
    const { restrictToBlurbIds } = expandBlurbs.mock.calls[0][0];
    expect(getReferencedBlurbIds).not.toHaveBeenCalled();

    expect(await restrictToBlurbIds()).toEqual([7]);
    expect(getReferencedBlurbIds).toHaveBeenCalledWith({
      entityType: 'ModelVersion',
      entityId: VERSION_ID,
    });
  });

  it('leaves the owner unrestricted', async () => {
    await upsert();

    expect(getReferencedBlurbIds).not.toHaveBeenCalled();
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToBlurbIds: undefined })
    );
  });
});

describe('upsertModelVersion — a non-owner creating a row', () => {
  // The lone asymmetry among the five surfaces: every other one keys the restriction on the actor
  // when creating, and this branch keyed it on `editsExistingVersion` alone. A moderator adding a
  // version to someone else's model then expanded as the OWNER with no restriction at all, so
  // guessed `data-id`s resolved and the creator's private blurb text came back in the response.
  it('🔴 restricts a moderator adding a NEW version to someone else’s model', async () => {
    await upsert({ id: undefined, actorUserId: MODERATOR_ID, isModerator: true });

    // A new row references nothing yet, so the allowed set is empty — never `undefined`, which
    // means "unrestricted".
    expect(getReferencedBlurbIds).not.toHaveBeenCalled();
    expect(expandBlurbs).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER_ID }));

    // A resolver that yields the empty set — NOT `undefined`, which means "unrestricted". The
    // two are different values of the same parameter and only one of them is safe here.
    const { restrictToBlurbIds } = expandBlurbs.mock.calls[0][0];
    expect(restrictToBlurbIds).toBeInstanceOf(Function);
    expect(await restrictToBlurbIds()).toEqual([]);
  });

  it('🔴 restricts a TEMPLATED write too, which creates a new row despite carrying an id', async () => {
    await upsert({ templateId: 5, actorUserId: MODERATOR_ID, isModerator: true });

    const { restrictToBlurbIds } = expandBlurbs.mock.calls[0][0];
    expect(restrictToBlurbIds).toBeInstanceOf(Function);
    expect(await restrictToBlurbIds()).toEqual([]);
  });

  it('leaves the OWNER creating a version unrestricted', async () => {
    await upsert({ id: undefined });

    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToBlurbIds: undefined })
    );
  });
});

describe('upsertModelVersion — blurb reconciliation', () => {
  it('reconciles in the same transaction as the write, against the version id', async () => {
    await upsert();

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'ModelVersion',
      entityId: VERSION_ID,
      uses: USES,
      tx: expect.anything(),
    });

    const [write] = dbMock.dbWrite.modelVersion.update.mock.invocationCallOrder;
    const [reconcile] = reconcileBlurbReferences.mock.invocationCallOrder;
    expect(reconcile).toBeGreaterThan(write);
  });

  it('reconciles a new version against the id it was created with', async () => {
    await upsert({ id: undefined });

    expect(reconcileBlurbReferences).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ModelVersion', entityId: CREATED_ID })
    );
  });

  it('🔴 leaves them alone when the caller supplied no description at all', async () => {
    // `requestReviewHandler` / `declineReviewHandler` re-save a version from a select that has no
    // `description`. Prisma leaves the column alone for an `undefined`, so the blurb markup stays
    // in the body — but `expandBlurbs('')` returns `{evaluated:true, uses:[]}`, and reconciling on
    // that deletes every reference row for the version. The markup then has nothing maintaining
    // it: the fan-out selects through BlurbReference, so it never touches that version again.
    // A moderator's decline is one of the two callers, so this strands a creator's content.
    expandBlurbs.mockResolvedValue({ evaluated: true, html: '', uses: [] });

    await upsert({ description: undefined });

    expect(reconcileBlurbReferences).not.toHaveBeenCalled();
  });

  it('leaves an existing reference row alone when the flag is off for the owner', async () => {
    // Reconciling on an unevaluated expansion deletes EVERY reference row for the version, and the
    // fan-out — deliberately ungated so it can still maintain them — then has nothing left.
    expandBlurbs.mockResolvedValue({ evaluated: false, html: CLIENT_HTML });

    await upsert();

    expect(reconcileBlurbReferences).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalled();
  });
});

describe('applyModelVersionContentChange', () => {
  it('writes the description column and nothing else', async () => {
    await applyModelVersionContentChange({ id: VERSION_ID, description: EXPANDED_HTML });

    // The fan-out calls this with nothing but new HTML. Route it back through the form-shaped
    // upsert and the failure mode is silent field loss — base model, files, monetization and
    // recommended resources cleared on every version the job touches.
    const [sql, ...extra] = descriptionSql();
    expect(extra).toEqual([]);
    expect(sql).toMatch(/WHERE id =/);
    expect(sql).not.toMatch(/name|baseModel|status|trainedWords/);
  });

  it('writes through raw SQL so a re-materialization does not bump updatedAt', async () => {
    await applyModelVersionContentChange({ id: VERSION_ID, description: EXPANDED_HTML });

    expect(descriptionSql()).toHaveLength(1);
    expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
  });

  it('skips the column write when the caller already committed it', async () => {
    // `upsertModelVersion` passes its post-write snapshot. Delete that and this replays the body
    // over a save that committed in between.
    await applyModelVersionContentChange({
      id: VERSION_ID,
      description: EXPANDED_HTML,
      context: { modelId: MODEL_ID },
    });

    expect(descriptionSql()).toEqual([]);
  });

  it('rejects a blocked link domain before writing anything', async () => {
    throwOnBlockedUserContent.mockRejectedValue(new Error('invalid urls: blocked.example'));

    await expect(
      applyModelVersionContentChange({ id: VERSION_ID, description: EXPANDED_HTML })
    ).rejects.toThrow('invalid urls');

    expect(descriptionSql()).toEqual([]);
  });

  it('reports a missing version rather than silently doing nothing', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(null);

    await expect(
      applyModelVersionContentChange({ id: VERSION_ID, description: EXPANDED_HTML })
    ).rejects.toThrow(/No model version with id/);
  });
});

// `bustModelLevelVersionCaches` — the three model-level caches that carry a version's data. All
// three were unasserted: delete the call and a fan-out rewrite leaves the model page and the
// public GET /api/v1/models/[id] body serving the pre-rewrite version description until TTL,
// with the search index never learning at all.
describe('applyModelVersionContentChange — the caches it must drop', () => {
  it('🔴 busts the MODEL-level caches, not the version id', async () => {
    await applyModelVersionContentChange({ id: VERSION_ID, description: EXPANDED_HTML });

    // Keyed on the model: `dataForModelsCache` and the public response cache are both per-model,
    // so passing the version id here drops nothing and reads as working.
    expect(refreshDataForModelsCache).toHaveBeenCalledWith([MODEL_ID]);
  });
});

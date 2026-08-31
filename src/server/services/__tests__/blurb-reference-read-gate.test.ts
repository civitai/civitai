import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as FliptClient from '~/server/flipt/client';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ModelModerationAdapter from '~/server/services/model-moderation.adapter';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as AutoNsfw from '~/server/services/auto-nsfw';

// The seam `blurb-model-wiring.test.ts` cannot see. That suite mocks
// `blurb-materialize.service` wholesale, so it pins which ARGUMENTS the service passes and
// never executes the flag gate — the question of WHEN the blurb tables are read falls between
// the two surfaces and is owned by neither.
//
// So this file runs `upsertModel` against the REAL blurb-materialize module and asserts on the
// db mock: the invariant is that `BlurbReference` is not read unless the flag is on for the
// owner AND the content actually carries blurb spans. Everything else is stubbed exactly as the
// wiring suite stubs it (with no live Redis those awaits never settle and the tests hang).
const {
  throwOnBlockedLinkDomain,
  submitModelTextModeration,
  preventReplicationLag,
  evaluateAutoNsfw,
  isFlipt,
} = vi.hoisted(() => ({
  throwOnBlockedLinkDomain: vi.fn(),
  submitModelTextModeration: vi.fn(),
  preventReplicationLag: vi.fn(async () => undefined),
  evaluateAutoNsfw: vi.fn(),
  isFlipt: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain,
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

import { upsertModel } from '~/server/services/model.service';

const MODEL_ID = 51;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

const PLAIN_HTML = '<p>no blurbs here</p>';
const BLURB_HTML = '<div data-type="blurb" data-id="7">CLIENT TEXT</div>';

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
    description: PLAIN_HTML,
    type: 'Checkpoint',
    uploadType: 'Created',
    status: 'Draft',
    ...input,
  } as never);

/** A moderator saving someone else's model — the only path that restricts the resolvable set. */
const moderatorUpsert = (input: Record<string, unknown> = {}) =>
  upsert({ userId: MODERATOR_ID, isModerator: true, ...input });

beforeEach(() => {
  vi.clearAllMocks();
  isFlipt.mockResolvedValue(true);
  throwOnBlockedLinkDomain.mockResolvedValue(undefined);
  submitModelTextModeration.mockResolvedValue(undefined);
  evaluateAutoNsfw.mockReturnValue(null);
  dbMock.dbRead.blurbReference.findMany.mockResolvedValue([]);
  dbMock.dbRead.blurb.findMany.mockResolvedValue([]);
  dbMock.dbWrite.blurbReference.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.blurbReference.upsert.mockResolvedValue({});
  dbMock.dbRead.model.findUnique.mockResolvedValue(storedModel);
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    name: storedModel.name,
    nsfw: false,
    lockedProperties: [],
    meta: null,
  });
  dbMock.dbWrite.model.update.mockResolvedValue({
    id: MODEL_ID,
    name: 'A model',
    description: PLAIN_HTML,
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

// A `dbRead.blurbReference` read can only be the restrict read — reconcile reads through the
// write client. That is what makes every zero below attributable.
describe('BlurbReference is not read outside the feature gate', () => {
  it('does not read BlurbReference when the flag is off for the owner', async () => {
    isFlipt.mockResolvedValue(false);

    await moderatorUpsert({ description: BLURB_HTML });

    // Flag off means the feature is off, end to end. A read here is the kill switch failing to
    // switch anything off — the residual production failure that survives flipping the flag
    // while `BlurbReference` does not yet exist.
    expect(dbMock.dbRead.blurbReference.findMany).not.toHaveBeenCalled();
  });

  it('does not read BlurbReference on a save that omits the description column', async () => {
    // The review handlers select without `description`. Nothing about the blurb spans in the
    // stored body can change on such a write, so the referenced-id set has nothing to filter.
    await moderatorUpsert({ description: undefined });

    expect(dbMock.dbRead.blurbReference.findMany).not.toHaveBeenCalled();
  });

  it('still reads BlurbReference when a moderator saves content that DOES carry spans', async () => {
    // The positive control for the two zeros above: same suite, same fixture, one field changed.
    // Without it a resolver wired to nothing would satisfy both assertions.
    await moderatorUpsert({ description: BLURB_HTML });

    expect(dbMock.dbRead.blurbReference.findMany).toHaveBeenCalledWith({
      where: { entityType: 'Model', entityId: MODEL_ID },
      select: { blurbId: true },
    });
  });

  it('leaves the owner unrestricted — no restrict read even with spans present', async () => {
    // Invariant guard, not a regression test: this held before the change too. It is here so a
    // later "just resolve it for everyone" simplification of the restrict predicate goes red.
    await upsert({ description: BLURB_HTML });

    expect(dbMock.dbRead.blurbReference.findMany).not.toHaveBeenCalled();
    // …and the owner's own blurbs ARE resolved, so this is not "the path never ran".
    expect(dbMock.dbRead.blurb.findMany).toHaveBeenCalled();
  });
});

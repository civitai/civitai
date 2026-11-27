import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { NsfwLevel } from '~/server/common/enums';
import {
  getAssociatedResourcesSimple,
  setAssociatedResources,
} from '~/server/services/model.service';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { AssociatedModelAddons } from '~/server/services/associated-model-visibility';
import type { SessionUser } from '~/types/session';

const FROM_OWNER = 7;
const ITEM_OWNER = 20;
const FROM = 100;
const EXCLUDED_TAG = 500;

type Seed = {
  id: number;
  nsfwLevel?: number;
  status?: string;
  availability?: string;
  mode?: string | null;
  poi?: boolean;
  minor?: boolean;
  sfwName?: string | null;
};

const MODELS = {
  live: { id: 1 },
  mature: { id: 2, nsfwLevel: NsfwLevel.X },
  deleted: { id: 3, status: 'Deleted' },
  unpublished: { id: 4, status: 'Unpublished' },
  draft: { id: 5, status: 'Draft' },
  private: { id: 6, availability: 'Private' },
  takenDown: { id: 7, mode: 'TakenDown' },
  poi: { id: 8, poi: true },
  faced: { id: 9, sfwName: 'Safe title' },
  minor: { id: 10, minor: true },
  unrated: { id: 11, nsfwLevel: 0 },
  tagged: { id: 12 },
} satisfies Record<string, Seed>;

const PG = publicBrowsingLevelsFlag;
const ALL = allBrowsingLevelsFlag;
const anon = undefined;
const stranger = { id: 8 } as SessionUser;
const itemOwner = { id: ITEM_OWNER } as SessionUser;
const moderator = { id: 9, isModerator: true } as SessionUser;
const fromOwner = { id: FROM_OWNER } as SessionUser;
const readerOf = (viewer: SessionUser | undefined) => ({
  isRestricted: () => false,
  viewer: viewer ?? {},
});

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

async function link(fromModelId: number, toModelIds: number[]) {
  for (const [i, toModelId] of toModelIds.entries()) {
    await h.pg.query(
      `INSERT INTO "ModelAssociations" (id, "fromModelId", "toModelId", type, index) VALUES ($1, $2, $3, 'Suggested', $4)`,
      [fromModelId * 100 + toModelId, fromModelId, toModelId, i]
    );
  }
}

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TYPE "ModelType" AS ENUM ('Checkpoint', 'LORA');
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "AssociationType" AS ENUM ('Suggested');
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp(3), image text, "profilePictureId" int);
    CREATE TABLE "Model" (
      id int PRIMARY KEY, name text NOT NULL, type "ModelType" NOT NULL DEFAULT 'LORA',
      "nsfwLevel" int NOT NULL, "userId" int NOT NULL, status "ModelStatus" NOT NULL,
      availability "Availability" NOT NULL, mode "ModelModifier", poi boolean NOT NULL,
      minor boolean NOT NULL DEFAULT false, "sfwName" text
    );
    CREATE TABLE "Article" (id int PRIMARY KEY);
    CREATE TABLE "TagsOnModels" ("modelId" int NOT NULL, "tagId" int NOT NULL, PRIMARY KEY ("modelId", "tagId"));
    CREATE TABLE "ModelAssociations" (
      id serial PRIMARY KEY, "fromModelId" int NOT NULL, "toModelId" int, "toArticleId" int,
      "associatedById" int, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      type "AssociationType" NOT NULL, index int
    );
    INSERT INTO "User" (id, username) VALUES (${FROM_OWNER}, 'from-owner'), (${ITEM_OWNER}, 'item-owner');
  `);
  for (const fromId of [FROM, 101, 102, 103, 104, 105, 106, 107]) {
    await h.pg.query(
      `INSERT INTO "Model" (id, name, "nsfwLevel", "userId", status, availability, poi) VALUES ($1, 'from', 1, $2, 'Published', 'Public', false)`,
      [fromId, FROM_OWNER]
    );
  }
  for (const [key, m] of Object.entries(MODELS) as [string, Seed][]) {
    await h.pg.query(
      `INSERT INTO "Model" (id, name, "nsfwLevel", "userId", status, availability, mode, poi, minor, "sfwName")
       VALUES ($1, $2, $3, $4, $5::"ModelStatus", $6::"Availability", $7::"ModelModifier", $8, $9, $10)`,
      [
        m.id,
        key,
        m.nsfwLevel ?? NsfwLevel.PG,
        ITEM_OWNER,
        m.status ?? 'Published',
        m.availability ?? 'Public',
        m.mode ?? null,
        m.poi ?? false,
        m.minor ?? false,
        m.sfwName ?? null,
      ]
    );
  }
  await h.pg.query(`INSERT INTO "TagsOnModels" ("modelId", "tagId") VALUES ($1, $2)`, [
    MODELS.tagged.id,
    EXCLUDED_TAG,
  ]);
  await link(
    FROM,
    Object.values(MODELS).map((m) => m.id)
  );

  const { model, modelAssociations, $transaction } = dbMock.dbWrite;
  model.findUnique.mockImplementation(((args: never) => h.prisma.model.findUnique(args)) as never);
  model.findMany.mockImplementation(((args: never) => h.prisma.model.findMany(args)) as never);
  modelAssociations.findMany.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.findMany(args)) as never);
  modelAssociations.deleteMany.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.deleteMany(args)) as never);
  modelAssociations.upsert.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.upsert(args)) as never);
  $transaction.mockImplementation(((ops: never) => h.prisma.$transaction(ops)) as never);
}, 60_000);

afterAll(() => h?.stop());

const listed = async (
  viewer: SessionUser | undefined,
  browsingLevel: number,
  addons: AssociatedModelAddons = {}
) =>
  (
    await getAssociatedResourcesSimple(
      { fromId: FROM, type: 'Suggested', browsingLevel, ...addons },
      readerOf(viewer),
      viewer
    )
  ).items.map(({ item }) => item.id);

// Visibility rule for linked models set in civitai/civitai#10680.
describe('getAssociatedResourcesSimple model side', () => {
  it('hides a mature model from a PG viewer and a signed-out viewer, shows it at a mature level', async () => {
    expect(await listed(stranger, PG)).not.toContain(MODELS.mature.id);
    expect(await listed(anon, PG)).not.toContain(MODELS.mature.id);
    expect(await listed(stranger, PG)).toContain(MODELS.live.id);
    expect(await listed(stranger, NsfwLevel.X)).toContain(MODELS.mature.id);
  });

  it('hides a mature model from its owner and moderators at PG too', async () => {
    expect(await listed(itemOwner, PG)).not.toContain(MODELS.mature.id);
    expect(await listed(moderator, PG)).not.toContain(MODELS.mature.id);
    expect(await listed(itemOwner, NsfwLevel.X)).toContain(MODELS.mature.id);
  });

  it('shows an unrated model to its owner and moderators only', async () => {
    expect(await listed(itemOwner, PG)).toContain(MODELS.unrated.id);
    expect(await listed(moderator, PG)).toContain(MODELS.unrated.id);
    expect(await listed(stranger, ALL)).not.toContain(MODELS.unrated.id);
    expect(await listed(anon, ALL)).not.toContain(MODELS.unrated.id);
  });

  it('with minor content off, hides a minor-flagged model from everyone but its owner', async () => {
    const off = { disableMinor: true };
    expect(await listed(anon, PG, off)).not.toContain(MODELS.minor.id);
    expect(await listed(stranger, PG, off)).not.toContain(MODELS.minor.id);
    expect(await listed(moderator, PG, off)).not.toContain(MODELS.minor.id);
    expect(await listed(itemOwner, PG, off)).toContain(MODELS.minor.id);
    expect(await listed(stranger, PG, off)).toContain(MODELS.live.id);
    expect(await listed(stranger, PG)).toContain(MODELS.minor.id);
  });

  it('with a tag excluded, hides a model carrying it from everyone but its owner', async () => {
    const excluded = { excludedTagIds: [EXCLUDED_TAG] };
    expect(await listed(anon, PG, excluded)).not.toContain(MODELS.tagged.id);
    expect(await listed(stranger, PG, excluded)).not.toContain(MODELS.tagged.id);
    expect(await listed(itemOwner, PG, excluded)).toContain(MODELS.tagged.id);
    expect(await listed(stranger, PG, excluded)).toContain(MODELS.live.id);
    expect(await listed(stranger, PG)).toContain(MODELS.tagged.id);
  });

  it.each(['deleted', 'unpublished', 'draft', 'private', 'takenDown', 'poi'] as const)(
    'a %s model is listed only to its owner and moderators',
    async (state) => {
      const id = MODELS[state].id;
      expect(await listed(anon, ALL)).not.toContain(id);
      expect(await listed(stranger, ALL)).not.toContain(id);
      expect(await listed(fromOwner, ALL)).not.toContain(id);
      expect(await listed(itemOwner, ALL)).toContain(id);
      expect(await listed(moderator, ALL)).toContain(id);
    }
  );

  it('a public PG model is listed to everyone', async () => {
    for (const viewer of [anon, stranger, fromOwner, itemOwner, moderator])
      expect(await listed(viewer, PG)).toContain(MODELS.live.id);
  });

  it('names a model by its .com face at a safe level and by its own name at a mature one', async () => {
    const nameAt = async (browsingLevel: number) => {
      const { items } = await getAssociatedResourcesSimple(
        { fromId: FROM, type: 'Suggested', browsingLevel },
        readerOf(stranger),
        stranger
      );
      const item = items.find(
        (x) => x.resourceType === 'model' && x.item.id === MODELS.faced.id
      )?.item;
      if (item && !('name' in item)) throw new Error('expected a model item');
      return { name: item?.name, keys: Object.keys(item ?? {}).sort() };
    };
    expect((await nameAt(PG)).name).toBe('Safe title');
    expect((await nameAt(ALL)).name).toBe('faced');
    expect((await nameAt(PG)).keys).toEqual(['id', 'name', 'nsfwLevel', 'type', 'user']);
  });
});

describe('setAssociatedResources model side', () => {
  const remaining = async (fromModelId: number) =>
    (
      await h.prisma.modelAssociations.findMany({
        where: { fromModelId },
        select: { toModelId: true },
      })
    ).map((x) => x.toModelId);

  it('keeps a link the editor did not list, and removes one it did', async () => {
    await link(101, [MODELS.live.id, MODELS.mature.id, MODELS.private.id]);
    await setAssociatedResources(
      { fromId: 101, type: 'Suggested', associations: [], browsingLevel: PG },
      fromOwner,
      readerOf(fromOwner),
      fromOwner
    );
    expect((await remaining(101)).sort()).toEqual([MODELS.mature.id, MODELS.private.id]);
  });

  it('removes a mature link the editor listed at a mature level', async () => {
    await link(102, [MODELS.mature.id]);
    await setAssociatedResources(
      { fromId: 102, type: 'Suggested', associations: [], browsingLevel: ALL },
      fromOwner,
      readerOf(fromOwner),
      fromOwner
    );
    expect(await remaining(102)).toEqual([]);
  });

  it('with minor content off, keeps a minor-flagged link the editor did not list', async () => {
    const save = (fromId: number, disableMinor?: boolean) =>
      setAssociatedResources(
        { fromId, type: 'Suggested', associations: [], browsingLevel: ALL, disableMinor },
        fromOwner,
        readerOf(fromOwner),
        fromOwner
      );
    await link(103, [MODELS.minor.id]);
    await save(103, true);
    expect(await remaining(103)).toEqual([MODELS.minor.id]);

    await link(104, [MODELS.minor.id]);
    await save(104);
    expect(await remaining(104)).toEqual([]);
  });

  it('with a tag excluded, keeps a link carrying it that the editor did not list', async () => {
    const save = (fromId: number, excludedTagIds?: number[]) =>
      setAssociatedResources(
        { fromId, type: 'Suggested', associations: [], browsingLevel: ALL, excludedTagIds },
        fromOwner,
        readerOf(fromOwner),
        fromOwner
      );
    await link(105, [MODELS.tagged.id]);
    await save(105, [EXCLUDED_TAG]);
    expect(await remaining(105)).toEqual([MODELS.tagged.id]);

    await link(106, [MODELS.tagged.id]);
    await save(106);
    expect(await remaining(106)).toEqual([]);
  });

  // Mod Lead ruling: a link is written only to a model the editor can see, and the browsing level
  // binds the owner too. Do not relax this to status-only checks.
  describe('refuses to newly link a model the editor cannot see', () => {
    const linkTo = (toModelId: number, browsingLevel: number) =>
      setAssociatedResources(
        {
          fromId: 107,
          type: 'Suggested',
          associations: [{ resourceId: toModelId, resourceType: 'model' }],
          browsingLevel,
        },
        fromOwner,
        readerOf(fromOwner),
        fromOwner
      );

    it('refuses an owner browsing at PG a mature target, and links it at a mature level', async () => {
      await expect(linkTo(MODELS.mature.id, PG)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await remaining(107)).toEqual([]);
      await linkTo(MODELS.mature.id, ALL);
      expect(await remaining(107)).toEqual([MODELS.mature.id]);
    });

    it.each(['private', 'unpublished', 'takenDown'] as const)(
      'refuses a %s model of another user',
      async (state) => {
        await expect(linkTo(MODELS[state].id, ALL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(await remaining(107)).not.toContain(MODELS[state].id);
      }
    );
  });
});

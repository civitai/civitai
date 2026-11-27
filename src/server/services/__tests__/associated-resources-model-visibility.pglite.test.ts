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
import type { SessionUser } from '~/types/session';

const FROM_OWNER = 7;
const ITEM_OWNER = 20;
const FROM = 100;

type Seed = {
  id: number;
  nsfwLevel?: number;
  status?: string;
  availability?: string;
  mode?: string | null;
  poi?: boolean;
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
} satisfies Record<string, Seed>;

const PG = publicBrowsingLevelsFlag;
const ALL = allBrowsingLevelsFlag;
const anon = undefined;
const stranger = { id: 8 } as SessionUser;
const itemOwner = { id: ITEM_OWNER } as SessionUser;
const moderator = { id: 9, isModerator: true } as SessionUser;
const fromOwner = { id: FROM_OWNER } as SessionUser;

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
      "sfwName" text
    );
    CREATE TABLE "Article" (id int PRIMARY KEY);
    CREATE TABLE "ModelAssociations" (
      id int PRIMARY KEY, "fromModelId" int NOT NULL, "toModelId" int, "toArticleId" int,
      "associatedById" int, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      type "AssociationType" NOT NULL, index int
    );
    INSERT INTO "User" (id, username) VALUES (${FROM_OWNER}, 'from-owner'), (${ITEM_OWNER}, 'item-owner');
  `);
  for (const fromId of [FROM, 101, 102]) {
    await h.pg.query(
      `INSERT INTO "Model" (id, name, "nsfwLevel", "userId", status, availability, poi) VALUES ($1, 'from', 1, $2, 'Published', 'Public', false)`,
      [fromId, FROM_OWNER]
    );
  }
  for (const [key, m] of Object.entries(MODELS) as [string, Seed][]) {
    await h.pg.query(
      `INSERT INTO "Model" (id, name, "nsfwLevel", "userId", status, availability, mode, poi, "sfwName")
       VALUES ($1, $2, $3, $4, $5::"ModelStatus", $6::"Availability", $7::"ModelModifier", $8, $9)`,
      [
        m.id,
        key,
        m.nsfwLevel ?? NsfwLevel.PG,
        ITEM_OWNER,
        m.status ?? 'Published',
        m.availability ?? 'Public',
        m.mode ?? null,
        m.poi ?? false,
        m.sfwName ?? null,
      ]
    );
  }
  await link(
    FROM,
    Object.values(MODELS).map((m) => m.id)
  );

  const { model, modelAssociations, $transaction } = dbMock.dbWrite;
  model.findUnique.mockImplementation(((args: never) => h.prisma.model.findUnique(args)) as never);
  modelAssociations.findMany.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.findMany(args)) as never);
  modelAssociations.deleteMany.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.deleteMany(args)) as never);
  modelAssociations.upsert.mockImplementation(((args: never) =>
    h.prisma.modelAssociations.upsert(args)) as never);
  $transaction.mockImplementation(((ops: never) => h.prisma.$transaction(ops)) as never);
}, 60_000);

afterAll(() => h?.stop());

const listed = async (viewer: SessionUser | undefined, browsingLevel: number, fromId = FROM) =>
  (
    await getAssociatedResourcesSimple({ fromId, type: 'Suggested', browsingLevel }, viewer, viewer)
  ).map(({ item }) => item.id);

describe('getAssociatedResourcesSimple model side', () => {
  it('hides a mature model from a PG viewer and a signed-out viewer, shows it at a mature level', async () => {
    expect(await listed(stranger, PG)).not.toContain(MODELS.mature.id);
    expect(await listed(anon, PG)).not.toContain(MODELS.mature.id);
    expect(await listed(stranger, PG)).toContain(MODELS.live.id);
    expect(await listed(stranger, NsfwLevel.X)).toContain(MODELS.mature.id);
  });

  it('shows a mature model to its owner and moderators at PG', async () => {
    expect(await listed(itemOwner, PG)).toContain(MODELS.mature.id);
    expect(await listed(moderator, PG)).toContain(MODELS.mature.id);
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
      const items = await getAssociatedResourcesSimple(
        { fromId: FROM, type: 'Suggested', browsingLevel },
        stranger,
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
      fromOwner
    );
    expect((await remaining(101)).sort()).toEqual([MODELS.mature.id, MODELS.private.id]);
  });

  it('removes a mature link the editor listed at a mature level', async () => {
    await link(102, [MODELS.mature.id]);
    await setAssociatedResources(
      { fromId: 102, type: 'Suggested', associations: [], browsingLevel: ALL },
      fromOwner,
      fromOwner
    );
    expect(await remaining(102)).toEqual([]);
  });
});

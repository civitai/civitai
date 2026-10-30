import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getBasicDataForUsers, getProfilePicturesForUsers } = vi.hoisted(() => ({
  getBasicDataForUsers: vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { id, username: `u${id}`, deletedAt: null }]))
  ),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user.service', () => ({
  getBasicDataForUsers,
  getProfilePicturesForUsers,
}));

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// The real SQL, run on PGlite: a predicate that names the wrong key or the wrong column lists everyone.
dbMock.dbRead.$queryRaw.mockImplementation((async (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
}) as never);

const { getImageReactors } = await import('~/server/services/image-reactors.service');
const { maskHiddenReactors } = await import('~/server/services/reaction-privacy.service');
const { HIDDEN_REACTOR_ID } = await import('~/shared/constants/reaction-privacy.constants');

const OWNER = 100;
const IMAGE = 555;
const LISTED = 30;
const HIDDEN = 20;
const OPTED_BACK_IN = 10; // turned the setting on, then off again

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, settings jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "ImageReaction" (
      "imageId" int, "userId" int, reaction text, "createdAt" timestamp NOT NULL DEFAULT '2026-10-01'
    );
    INSERT INTO "User" VALUES
      (${OWNER}, '{"hideFromReactionLists": true}'),
      (${LISTED}, '{"hideFromCreatorShowcase": true}'),
      (${HIDDEN}, '{"hideFromReactionLists": true}'),
      (${OPTED_BACK_IN}, '{"hideFromReactionLists": false}');
    INSERT INTO "ImageReaction" VALUES
      (${IMAGE}, ${LISTED}, 'Like'), (${IMAGE}, ${HIDDEN}, 'Like'), (${IMAGE}, ${HIDDEN}, 'Heart'),
      (${IMAGE}, ${OPTED_BACK_IN}, 'Cry'), (${IMAGE}, ${OWNER}, 'Laugh');
  `);
});

beforeEach(() => {
  dbMock.dbRead.user.findUnique.mockResolvedValue(null);
  dbMock.dbRead.image.findUnique.mockResolvedValue({ userId: OWNER } as never);
});

describe('getImageReactors — hide me from reaction lists', () => {
  it('leaves out an opted-out reactor, keeps everyone else and the owner themselves', async () => {
    const reactors = await getImageReactors({ imageId: IMAGE, userId: OWNER });
    expect(reactors.map((r) => r.userId)).toEqual([OWNER, LISTED, OPTED_BACK_IN]);
  });
});

describe('getImageReactors — image reactions from before the lists launched', () => {
  const PRE_IMAGE = 556;
  const BEFORE = '2026-09-23 17:07:39';
  const AT_LAUNCH = '2026-09-23 17:07:40';
  const QUIET = 60; // reacted before launch, never opted in
  const OPTED_IN = 50;
  const OPTED_IN_BUT_HIDDEN = 40;
  const AFTER = 31; // reacted at the launch instant
  const listed = async () =>
    (await getImageReactors({ imageId: PRE_IMAGE, userId: OWNER })).map((r) => r.userId);

  beforeAll(async () => {
    await holder.db.exec(`
      INSERT INTO "User" VALUES
        (${QUIET}, '{"showPreLaunchReactions": false}'),
        (${OPTED_IN}, '{"showPreLaunchReactions": true}'),
        (${OPTED_IN_BUT_HIDDEN}, '{"showPreLaunchReactions": true, "hideFromReactionLists": true}'),
        (${AFTER}, '{}');
      INSERT INTO "ImageReaction" VALUES
        (${PRE_IMAGE}, ${QUIET}, 'Like', '${BEFORE}'),
        (${PRE_IMAGE}, ${OPTED_IN}, 'Heart', '${BEFORE}'),
        (${PRE_IMAGE}, ${OPTED_IN_BUT_HIDDEN}, 'Like', '${BEFORE}'),
        (${PRE_IMAGE}, ${AFTER}, 'Like', '${AT_LAUNCH}'),
        (${PRE_IMAGE}, ${OWNER}, 'Cry', '${BEFORE}');
    `);
  });

  afterEach(() =>
    holder.db.exec(`UPDATE "User" SET settings = '{}' WHERE id IN (${QUIET}, ${AFTER})`)
  );

  it('leaves out an older reaction by default, keeps one from launch on, the opted-in, and the owner', async () => {
    expect(await listed()).toEqual([OWNER, OPTED_IN, AFTER]);
  });

  it('lists the same older reaction once its reactor opts in, and drops it again when they opt out', async () => {
    await holder.db.exec(
      `UPDATE "User" SET settings = '{"showPreLaunchReactions": true}' WHERE id = ${QUIET}`
    );
    expect(await listed()).toEqual([OWNER, QUIET, OPTED_IN, AFTER]);
    await holder.db.exec(`UPDATE "User" SET settings = '{}' WHERE id = ${QUIET}`);
    expect(await listed()).toEqual([OWNER, OPTED_IN, AFTER]);
  });

  it('still hides a newer reaction from someone who opted out of reaction lists', async () => {
    await holder.db.exec(
      `UPDATE "User" SET settings = '{"hideFromReactionLists": true}' WHERE id = ${AFTER}`
    );
    expect(await listed()).toEqual([OWNER, OPTED_IN]);
  });
});

describe('maskHiddenReactors — comment reaction tooltips', () => {
  const reactions = () =>
    [LISTED, HIDDEN, HIDDEN, OPTED_BACK_IN].map((id, i) => ({
      id: i,
      reaction: 'Like',
      user: { id, username: `u${id}` },
    }));

  it('anonymises an opted-out reactor for someone else, keeping every row so counts are unchanged', async () => {
    const list = reactions();
    await maskHiddenReactors([list], { id: OWNER });
    expect(list.map((r) => r.user)).toEqual([
      { id: LISTED, username: `u${LISTED}` },
      { id: HIDDEN_REACTOR_ID, username: null },
      { id: HIDDEN_REACTOR_ID, username: null },
      { id: OPTED_BACK_IN, username: `u${OPTED_BACK_IN}` },
    ]);
  });

  it('masks for a signed-out viewer too', async () => {
    const list = reactions();
    await maskHiddenReactors([list], undefined);
    expect(list.filter((r) => r.user.id === HIDDEN_REACTOR_ID)).toHaveLength(2);
  });

  it('shows an opted-out viewer their own reactions', async () => {
    const list = reactions();
    await maskHiddenReactors([list], { id: HIDDEN });
    expect(list.map((r) => r.user.id)).toEqual([LISTED, HIDDEN, HIDDEN, OPTED_BACK_IN]);
  });

  it('leaves a moderator the full view', async () => {
    const list = reactions();
    await maskHiddenReactors([list], { id: OWNER, isModerator: true });
    expect(list.map((r) => r.user.id)).toEqual([LISTED, HIDDEN, HIDDEN, OPTED_BACK_IN]);
  });
});

describe('comment.getReactions — the handler applies the mask', () => {
  it('anonymises an opted-out reactor and keeps the row', async () => {
    dbMock.dbRead.commentReaction.findMany.mockResolvedValue([
      { id: 1, reaction: 'Like', user: { id: LISTED, username: `u${LISTED}` } },
      { id: 2, reaction: 'Like', user: { id: HIDDEN, username: `u${HIDDEN}` } },
    ] as never);
    const { getCommentReactionsHandler } = await import('~/server/controllers/comment.controller');

    const result = await getCommentReactionsHandler({
      input: { commentId: 1 },
      ctx: { user: { id: OWNER } } as never,
    });
    expect(result.map((r) => r.user)).toEqual([
      { id: LISTED, username: `u${LISTED}` },
      { id: HIDDEN_REACTOR_ID, username: null },
    ]);
  });
});

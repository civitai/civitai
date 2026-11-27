import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootTagReview, createQueueDb } from '../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../test/seed';
import { getApprentice } from '$lib/server/apprenticeship/apprenticeship.service';
import { ensureVotePartitions } from '$lib/server/queue/queue.service';
import { pickYesNo } from '$lib/server/yesno/feed';
import { importYesNo } from '$lib/server/yesno/import';
import { runTagReview } from '$lib/server/yesno/tag-review';
import { flagTag, resetTagReview, staffPaladin, X } from '$lib/server/yesno/tag-review.fixtures';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  config: { share: 1, tagReview: true, stretch: 8, playerDefault: true },
}));
vi.mock('$lib/server/db', () => ({
  get db() {
    return state.db;
  },
  get dbRead() {
    return state.db;
  },
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn() }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => `cdn/${key}` }));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ ...state.config }) }));

const { pickItem } = await import('./next-item.server');
const { actions: settings } = await import('../settings/+page.server');

const NOW = new Date();
const PALADIN = 1;
const ACOLYTE = 2;
const GENERATED_IMAGE = 10;
const TAG_REVIEW_IMAGE = 100;
const PAIR_IMAGE = 200;

let pg: PGlite;
let db: Kysely<DB>;
let pairId: number;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  state.db = db;
  await bootTagReview(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());

beforeEach(async () => {
  state.config = { share: 1, tagReview: true, stretch: 8, playerDefault: true };
  await resetTagReview(pg, [[10, 'nudity', 'Moderation', X]]);
  await pg.exec(
    `TRUNCATE "KnightsYesNoReference","KnightsApprenticeAnswer","KnightsPlayer","KnightsImagePull" RESTART IDENTITY CASCADE`
  );
  await seedPlayer(pg, PALADIN, 'Paladin');
  await seedPlayer(pg, ACOLYTE, 'Acolyte');
  await staffPaladin(pg, PALADIN, new Date(NOW.getTime() - 86_400_000));

  await seedImage(pg, GENERATED_IMAGE, { nsfwLevel: 8, userId: 50 });
  await importYesNo(db, [
    {
      externalId: 'generated',
      imageId: GENERATED_IMAGE,
      axis: 'violence',
      audience: 'players',
      prompt: 'Is there blood?',
      yesEffect: 'R4',
      noEffect: 'R3',
      meta: {},
    },
  ]);

  await seedImage(pg, TAG_REVIEW_IMAGE, { nsfwLevel: X, userId: 50 });
  await flagTag(pg, TAG_REVIEW_IMAGE, 10);
  await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });

  await seedImage(pg, PAIR_IMAGE, { userId: 50 });
  ({
    rows: [{ id: pairId }],
  } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","active","createdBy")
     VALUES ($1,'knights.yesno.violence',true,true,1) RETURNING id`,
    [PAIR_IMAGE]
  ));
});

/** What each yes/no path deals right now, as image ids (null when it deals nothing). */
async function dealt() {
  const imageOf = async (itemId: number | undefined) =>
    itemId === undefined
      ? null
      : (
          await pg.query<{ imageId: number }>(
            `SELECT "imageId" FROM "KnightsQueueItem" WHERE id = $1`,
            [itemId]
          )
        ).rows[0].imageId;
  const offer = (share: number, tagReview: boolean) =>
    pickYesNo(db, {
      userId: PALADIN,
      rank: 'Paladin',
      secret: 'secret',
      share,
      tagReview,
      stretch: 8,
      force: true,
    });
  const picked = await pickItem(PALADIN, 'Paladin', null);
  const apprentice = await getApprentice(db, ACOLYTE);
  return {
    generated: await imageOf((await offer(1, false))?.itemId),
    tagReview: await imageOf((await offer(0, true))?.itemId),
    prefetch: picked?.question.kind === 'bool' ? 'yesno' : null,
    acolytePair:
      apprentice.kind === 'question' && apprentice.item.kind === 'yesno'
        ? apprentice.item.referenceId
        : null,
  };
}

// The rule: docs/features/knights-yesno-questions.md, "Serving": a question is offered only on an image `servableImage` accepts.
describe('the shared image gate on every yes/no path', () => {
  it('deals a yes/no on every path while the image passes KnightsImageGate, and none once the gate excludes it', async () => {
    expect(await dealt()).toEqual({
      generated: GENERATED_IMAGE,
      tagReview: TAG_REVIEW_IMAGE,
      prefetch: 'yesno',
      acolytePair: pairId,
    });

    await pg.query(`UPDATE "Image" SET "ingestion" = 'Blocked' WHERE id = ANY($1)`, [
      [GENERATED_IMAGE, TAG_REVIEW_IMAGE, PAIR_IMAGE],
    ]);
    const gate = await pg.query<{ imageId: number; servable: boolean }>(
      `SELECT "imageId", servable FROM "KnightsImageGate" WHERE "imageId" = ANY($1) ORDER BY 1`,
      [[GENERATED_IMAGE, TAG_REVIEW_IMAGE, PAIR_IMAGE]]
    );
    expect(gate.rows.every((r) => !r.servable)).toBe(true);

    expect(await dealt()).toEqual({
      generated: null,
      tagReview: null,
      prefetch: null,
      acolytePair: null,
    });
  });
});

// The rule: docs/features/knights-yesno-questions.md, "Reports": an image players pulled is out of every yes/no path.
describe('an image players pulled', () => {
  const pull = (imageId: number, resolvedAt: string | null = null) =>
    pg.query(
      `INSERT INTO "KnightsImagePull" ("imageId","reason","resolvedAt") VALUES ($1,'players-reported',$2)`,
      [imageId, resolvedAt]
    );

  it('deals no yes/no on any path while its pull is open, and again once a moderator kept it', async () => {
    for (const image of [GENERATED_IMAGE, TAG_REVIEW_IMAGE, PAIR_IMAGE]) await pull(image);
    expect(await dealt()).toEqual({
      generated: null,
      tagReview: null,
      prefetch: null,
      acolytePair: null,
    });

    await pg.query(`UPDATE "KnightsImagePull" SET "resolvedAt" = now()`);
    expect(await dealt()).toEqual({
      generated: GENERATED_IMAGE,
      tagReview: TAG_REVIEW_IMAGE,
      prefetch: 'yesno',
      acolytePair: pairId,
    });
  });
});

describe('the questions switch in Knights settings', () => {
  const turn = (value: 'on' | 'off') => {
    const body = new FormData();
    body.set('questions', value);
    return settings.questions({
      locals: { user: { id: PALADIN } },
      request: new Request('http://x', { method: 'POST', body }),
    } as never);
  };
  const stored = async () =>
    (
      await pg.query<{ yesNoQuestions: boolean | null }>(
        `SELECT "yesNoQuestions" FROM "KnightsPlayer" WHERE "playerId" = $1`,
        [PALADIN]
      )
    ).rows[0]?.yesNoQuestions;
  const dealsYesNo = async () =>
    (await pickItem(PALADIN, 'Paladin', null))?.question.kind === 'bool';

  it.each([
    ['generated questions', { share: 1, tagReview: false }],
    ['tag review', { share: 0, tagReview: true }],
  ])('turned off, deals the player no %s until it is turned back on', async (_source, sources) => {
    state.config = { ...state.config, ...sources };
    expect(await dealsYesNo()).toBe(true);

    expect(await turn('off')).toEqual({ questions: false });
    expect(await stored()).toBe(false);
    expect(await dealsYesNo()).toBe(false);

    expect(await turn('on')).toEqual({ questions: true });
    expect(await stored()).toBe(true);
    expect(await dealsYesNo()).toBe(true);
  });
});

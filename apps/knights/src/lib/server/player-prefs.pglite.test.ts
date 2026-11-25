import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';
import { seedPlayer } from '../../test/seed';
import { hiddenTagGroups, playerPrefs, setTagGroupHidden, setYesNoQuestions } from './player-prefs';

let pg: PGlite;
let db: Kysely<DB>;
const NOW = new Date('2026-12-15T12:00:00Z');

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsPlayer", "NewOrderPlayer", "User" RESTART IDENTITY`);
  await seedPlayer(pg, 1);
});

const stored = async () =>
  (
    await pg.query<{ yesNoQuestions: boolean | null }>(
      `SELECT "yesNoQuestions" FROM "KnightsPlayer" WHERE "playerId" = 1`
    )
  ).rows[0];

describe('the yes/no questions switch', () => {
  it('follows the default while the player has never set it, with or without a KnightsPlayer row', async () => {
    expect(await playerPrefs(db, 1, true)).toEqual({ yesNo: true });
    expect(await playerPrefs(db, 1, false)).toEqual({ yesNo: false });

    await pg.exec(
      `INSERT INTO "KnightsPlayer" ("playerId", "shieldWeek") VALUES (1, '2026-12-14')`
    );
    expect(await playerPrefs(db, 1, true)).toEqual({ yesNo: true });
    expect(await playerPrefs(db, 1, false)).toEqual({ yesNo: false });
  });

  it("keeps the player's own choice whatever the default says", async () => {
    await setYesNoQuestions(db, 1, false, NOW);
    expect(await playerPrefs(db, 1, true)).toEqual({ yesNo: false });

    await setYesNoQuestions(db, 1, true, NOW);
    expect(await playerPrefs(db, 1, false)).toEqual({ yesNo: true });
  });

  it('creates the KnightsPlayer row when the player has none, and leaves an existing row otherwise as it was', async () => {
    await setYesNoQuestions(db, 1, false, NOW);
    expect(await stored()).toEqual({ yesNoQuestions: false });

    await pg.exec(`UPDATE "KnightsPlayer" SET "streak" = 9 WHERE "playerId" = 1`);
    await setYesNoQuestions(db, 1, true, NOW);
    const row = (
      await pg.query<{ streak: number; yesNoQuestions: boolean }>(
        `SELECT "streak", "yesNoQuestions" FROM "KnightsPlayer" WHERE "playerId" = 1`
      )
    ).rows[0];
    expect(row).toEqual({ streak: 9, yesNoQuestions: true });
  });

  it('serves no yes/no question when the switch cannot be read', async () => {
    const broken = {
      selectFrom: () => {
        throw new Error('connection reset');
      },
    } as unknown as Kysely<DB>;
    expect(await playerPrefs(broken, 1, true)).toEqual({ yesNo: false });
  });
});

describe('the hidden tag groups', () => {
  it('starts with none, with or without a KnightsPlayer row', async () => {
    expect(await hiddenTagGroups(db, 1)).toEqual([]);
    await pg.exec(
      `INSERT INTO "KnightsPlayer" ("playerId", "shieldWeek") VALUES (1, '2026-12-14')`
    );
    expect(await hiddenTagGroups(db, 1)).toEqual([]);
  });

  it('hides and shows a group, once each however often it is sent, and leaves the other groups alone', async () => {
    await setTagGroupHidden(db, 1, 'anime', true, NOW);
    await setTagGroupHidden(db, 1, 'gore', true, NOW);
    await setTagGroupHidden(db, 1, 'anime', true, NOW);
    expect(await hiddenTagGroups(db, 1)).toEqual(['anime', 'gore']);

    await setTagGroupHidden(db, 1, 'anime', false, NOW);
    await setTagGroupHidden(db, 1, 'anime', false, NOW);
    expect(await hiddenTagGroups(db, 1)).toEqual(['gore']);
  });

  it('keeps the yes/no switch as it was', async () => {
    await setYesNoQuestions(db, 1, false, NOW);
    await setTagGroupHidden(db, 1, 'furry', true, NOW);
    expect(await stored()).toEqual({ yesNoQuestions: false });
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import {
  describeSnapshotError,
  fetchCandidates,
  purgeExpiredText,
  snapshotAutomatedText,
} from '../text-relabel-snapshot';
import { REPORT_ENTITIES } from '../report-entities';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODERATOR_SCHEMA = readFileSync(
  join(HERE, '../../../../automated-text-eval/schema.sql'),
  'utf8'
);

// The main-database tables the snapshot reads, cut to the columns it touches.
const MAIN_TABLES = `
CREATE TABLE "Report" (id int PRIMARY KEY, details jsonb);
CREATE TABLE "ReportAutomated" (
  id serial PRIMARY KEY, "reportId" int NOT NULL UNIQUE, metadata jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamp NOT NULL DEFAULT now()
);
${REPORT_ENTITIES.map(
  (e) => `CREATE TABLE "${e.reportTable}" ("reportId" int NOT NULL, "${e.fk}" int NOT NULL);`
).join('\n')}
`;

const SECRET = 'flagged-text-that-must-never-be-printed';

let mainPg: PGlite;
let modPg: PGlite;
let main: Kysely<MainDB>;
let mod: Kysely<ModeratorDB>;

type Tag = { tag: string; confidence: number | string };

async function seedHit(
  reportId: number,
  tags: Tag[],
  entity: { table: string; col: string; id: number } = {
    table: 'CommentV2Report',
    col: 'commentV2Id',
    id: reportId * 10,
  },
  opts: { text?: string; authorId?: number | string } = {}
) {
  await mainPg.query(`INSERT INTO "Report" (id, details) VALUES ($1, $2)`, [
    reportId,
    JSON.stringify({ userId: opts.authorId ?? reportId + 1000 }),
  ]);
  await mainPg.query(`INSERT INTO "ReportAutomated" ("reportId", metadata) VALUES ($1, $2)`, [
    reportId,
    JSON.stringify({
      tags: tags.map((t) => ({ ...t, outcome: 'TRUE', message: '' })),
      value: opts.text ?? `${SECRET} #${reportId}`,
    }),
  ]);
  await mainPg.query(
    `INSERT INTO "${entity.table}" ("reportId", "${entity.col}") VALUES ($1, $2)`,
    [reportId, entity.id]
  );
}

const run = (over: Partial<Parameters<typeof snapshotAutomatedText>[0]> = {}) =>
  snapshotAutomatedText(
    { batch: 'b1', seed: 's', dryRun: false, now: new Date('2026-10-04T00:00:00Z'), ...over },
    { replica: main, moderator: mod }
  );

beforeAll(async () => {
  [mainPg, modPg] = await Promise.all([PGlite.create(), PGlite.create()]);
  await Promise.all([mainPg.exec(MAIN_TABLES), modPg.exec(MODERATOR_SCHEMA)]);
  main = new Kysely<MainDB>({ dialect: pgliteDialect(mainPg) });
  mod = new Kysely<ModeratorDB>({ dialect: pgliteDialect(modPg) });
}, 60_000);

beforeEach(async () => {
  await mainPg.exec(
    `TRUNCATE "Report", "ReportAutomated", ${REPORT_ENTITIES.map((e) => `"${e.reportTable}"`).join(
      ', '
    )}`
  );
  await modPg.exec('TRUNCATE text_relabel_item RESTART IDENTITY CASCADE');
});

describe('fetchCandidates', () => {
  it('reads one pair per (report, tag), with the entity and author from the report', async () => {
    await seedHit(1, [
      { tag: 'CSAM', confidence: '77' },
      { tag: 'Grooming', confidence: '91' },
    ]);
    await seedHit(2, [{ tag: 'NSFW', confidence: '99' }], {
      table: 'ChatReport',
      col: 'chatId',
      id: 555,
    });
    const { candidates } = await fetchCandidates(main);
    const rows = candidates
      .map(({ flaggedAt, ...c }) => c)
      .sort((a, b) => a.reportId - b.reportId || a.tag.localeCompare(b.tag));
    expect(rows).toEqual([
      {
        reportId: 1,
        tag: 'CSAM',
        confidence: 77,
        authorId: 1001,
        entityType: 'commentV2',
        entityId: 10,
      },
      {
        reportId: 1,
        tag: 'Grooming',
        confidence: 91,
        authorId: 1001,
        entityType: 'commentV2',
        entityId: 10,
      },
      {
        reportId: 2,
        tag: 'NSFW',
        confidence: 99,
        authorId: 1002,
        entityType: 'chat',
        entityId: 555,
      },
    ]);
  });

  // Every report type the app knows, not a hand-kept subset: a type missing here would arrive as
  // 'unknown', and its hand-off would lose the report link.
  it('resolves report types beyond the common text ones', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: '70' }], {
      table: 'ChallengeReport',
      col: 'challengeId',
      id: 9,
    });
    const { candidates } = await fetchCandidates(main);
    expect(candidates.map((c) => [c.entityType, c.entityId])).toEqual([['challenge', 9]]);
  });

  // Clavata stores confidence as a string. Taking the max of the strings ranks '99' above '100',
  // which would put a repeated tag in the wrong band.
  it('compares a repeated tag by numeric confidence, not as text', async () => {
    await seedHit(1, [
      { tag: 'NSFW', confidence: '99' },
      { tag: 'NSFW', confidence: '100' },
    ]);
    const { candidates } = await fetchCandidates(main);
    expect(candidates.map((c) => c.confidence)).toEqual([100]);
  });

  it('counts a pair with no usable confidence instead of guessing its band', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: 'high' }]);
    await seedHit(2, [{ tag: 'CSAM', confidence: '60' }]);
    const { candidates, noConfidence } = await fetchCandidates(main);
    expect(noConfidence).toBe(1);
    expect(candidates.map((c) => c.reportId)).toEqual([2]);
  });

  it('drops an author id that is not a plain integer', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: '60' }], undefined, { authorId: 'abc' });
    const { candidates } = await fetchCandidates(main);
    expect(candidates[0].authorId).toBeNull();
  });
});

describe('snapshotAutomatedText', () => {
  it('copies the text of every picked pair, and its strata, into the moderator database', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: '77' }]);
    const summary = await run();
    expect(summary).toMatchObject({ inserted: 1, alreadyPresent: 0, textMissing: 0 });
    const rows = await mod.selectFrom('text_relabel_item').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      report_id: 1,
      tag: 'CSAM',
      wave: 1,
      entity_type: 'commentV2',
      entity_id: 10,
      author_id: 1001,
      visibility: 'public',
      confidence: 77,
      confidence_band: 'low',
      stratum_key: 'CSAM|low|public',
      cell_population: 1,
      text_value: `${SECRET} #1`,
    });
    expect(new Date(rows[0].purge_after).toISOString()).toBe('2027-01-02T00:00:00.000Z');
  });

  it('writes nothing on a dry run', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: '77' }]);
    const summary = await run({ dryRun: true });
    expect(summary.perTag.CSAM).toEqual({ window: 1, pool: 1, waveOne: 1 });
    expect(await mod.selectFrom('text_relabel_item').select('id').execute()).toHaveLength(0);
  });

  // The summary is what the CLI prints; the flagged text must never be part of it.
  it('returns counts only, never the text', async () => {
    for (let i = 1; i <= 5; i++) await seedHit(i, [{ tag: 'CSAM', confidence: '70' }]);
    const summary = await run();
    expect(summary.inserted).toBe(5);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  // A re-run must not move a pair between waves or re-stamp its text: its labels were given
  // against what was first copied.
  it('keeps the first snapshot of a pair on a re-run', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: '77' }]);
    await run();
    await mainPg.query(
      `UPDATE "ReportAutomated" SET metadata = jsonb_set(metadata, '{value}', '"edited"')`
    );
    const second = await run({ batch: 'b2' });
    expect(second).toMatchObject({ inserted: 0, alreadyPresent: 1 });
    const rows = await mod
      .selectFrom('text_relabel_item')
      .select(['batch', 'text_value'])
      .execute();
    expect(rows).toEqual([{ batch: 'b1', text_value: `${SECRET} #1` }]);
  });
});

describe('purgeExpiredText', () => {
  it('nulls the text past purge_after and keeps the row', async () => {
    await seedHit(1, [{ tag: 'CSAM', confidence: '77' }]);
    await seedHit(2, [{ tag: 'CSAM', confidence: '77' }]);
    await run({ purgeDays: 90 });
    await mod
      .updateTable('text_relabel_item')
      .set({ purge_after: new Date('2026-10-05T00:00:00Z') })
      .where('report_id', '=', 1)
      .execute();
    expect(await purgeExpiredText(mod, new Date('2026-10-06T00:00:00Z'))).toBe(1);
    const rows = await mod
      .selectFrom('text_relabel_item')
      .select(['report_id', 'text_value'])
      .orderBy('report_id')
      .execute();
    expect(rows).toEqual([
      { report_id: 1, text_value: null },
      { report_id: 2, text_value: `${SECRET} #2` },
    ]);
  });
});

describe('describeSnapshotError', () => {
  // Control first: the driver's own error DOES carry the row, so printing it would leak the text.
  it('keeps the identifiers of a database error and drops its row', async () => {
    let caught: unknown;
    try {
      await modPg.query(
        `INSERT INTO text_relabel_item (batch, report_id, tag, wave, entity_type, visibility,
           confidence, confidence_band, stratum_key, cell_population, text_value, flagged_at, purge_after)
         VALUES ('b', 1, 'CSAM', 9, 'chat', 'private', 50, 'low', 'k', 1, $1, now(), now())`,
        [SECRET]
      );
    } catch (e) {
      caught = e;
    }
    const raw = caught as { message?: string; detail?: string };
    expect(`${raw.message} ${raw.detail}`).toContain(SECRET);
    const described = describeSnapshotError(caught);
    expect(described).not.toContain(SECRET);
    expect(described).toContain('code=23514');
  });
});

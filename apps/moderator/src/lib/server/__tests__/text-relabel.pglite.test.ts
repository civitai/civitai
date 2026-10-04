import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import {
  labelerProgress,
  nextItem,
  ownAnswer,
  ownHandOffs,
  saveAnswer,
} from '../text-relabel.service';
import type { TextLabel } from '$lib/automated-text/labels';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// The hand-applied schema itself, so the two-labeler cap is tested where it is enforced.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../automated-text-eval/schema.sql'), 'utf8');

let pg: PGlite;
let db: Kysely<ModeratorDB>;
let nextReport = 1;

async function seedItem(over: Record<string, unknown> = {}): Promise<string> {
  const reportId = nextReport++;
  const row = await db
    .insertInto('text_relabel_item')
    .values({
      batch: 'b',
      report_id: reportId,
      tag: 'CSAM',
      wave: 1,
      entity_type: 'commentV2',
      entity_id: reportId * 10,
      author_id: reportId * 100,
      visibility: 'public',
      confidence: 77,
      confidence_band: 'low',
      stratum_key: 'CSAM|low|public',
      cell_population: 9,
      text_value: `text ${reportId}`,
      flagged_at: new Date('2026-10-01T00:00:00Z'),
      purge_after: new Date('2099-01-01T00:00:00Z'),
      ...over,
    })
    .returning('token')
    .executeTakeFirstOrThrow();
  return row.token;
}

const save = (labelerId: number, token: string, label: TextLabel = 'false_positive') =>
  saveAnswer(db, { labelerId, token, label, note: null, durationMs: 1000 });

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  db = new Kysely<ModeratorDB>({ dialect: pgliteDialect(pg) });
}, 60_000);

beforeEach(async () => {
  await pg.exec('TRUNCATE text_relabel_item RESTART IDENTITY CASCADE');
  nextReport = 1;
});

describe('the schema', () => {
  it('is re-runnable', async () => {
    await expect(pg.exec(SCHEMA)).resolves.toBeDefined();
  });

  it('refuses a label outside the four', async () => {
    const token = await seedItem();
    await expect(save(1, token, 'violation' as TextLabel)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('two labelers per item', () => {
  // Decision: at most two labels per item, so a second labeller gives an agreement number rather
  // than a vote.
  it('refuses a third labeler and keeps the first two', async () => {
    const token = await seedItem();
    expect(await save(1, token)).toEqual({ ok: true, tag: 'CSAM' });
    expect(await save(2, token)).toEqual({ ok: true, tag: 'CSAM' });
    expect(await save(3, token)).toEqual({ ok: false, reason: 'full' });
    const rows = await db
      .selectFrom('text_relabel_answer')
      .select('labeler_id')
      .orderBy('labeler_id')
      .execute();
    expect(rows.map((r) => r.labeler_id)).toEqual([1, 2]);
  });

  it('lets a labeler change their own answer on a full item', async () => {
    const token = await seedItem();
    await save(1, token);
    await save(2, token);
    expect(await save(1, token, 'clear_violation')).toEqual({ ok: true, tag: 'CSAM' });
    expect((await ownAnswer(db, 1, token))?.label).toBe('clear_violation');
  });
});

describe('nextItem', () => {
  // Blinding: the page must not receive confidence, stratum, wave, report or author ids.
  it('hands the labeler the token, tag, text and content kind, and nothing else', async () => {
    const token = await seedItem();
    expect(await nextItem(db, 1)).toEqual({
      token,
      tag: 'CSAM',
      text: 'text 1',
      entityLabel: 'Comment',
    });
  });

  // Decision: wave 1 is labelled before the rest of the pool is touched.
  it('serves every wave-1 item before any wave-2 item', async () => {
    const waveTwo = await Promise.all(Array.from({ length: 10 }, () => seedItem({ wave: 2 })));
    const waveOne = await seedItem({ wave: 1 });
    expect((await nextItem(db, 1))?.token).toBe(waveOne);
    await save(1, waveOne);
    expect(waveTwo).toContain((await nextItem(db, 1))?.token);
  });

  it('skips items the labeler answered, items with two answers, and skipped tokens', async () => {
    const mine = await seedItem();
    const full = await seedItem();
    const skipped = await seedItem();
    const open = await seedItem();
    await save(1, mine);
    await save(2, full);
    await save(3, full);
    expect((await nextItem(db, 1, [skipped]))?.token).toBe(open);
  });

  it('shows a chat with its speakers as letters, not user ids', async () => {
    await seedItem({ entity_type: 'chat', text_value: '[4411]: hi | [9002]: hey | [4411]: bye' });
    expect((await nextItem(db, 1))?.text).toBe(
      '[Speaker A]: hi | [Speaker B]: hey | [Speaker A]: bye'
    );
  });

  it('masks a chat-shaped text whose report row was gone at snapshot', async () => {
    await seedItem({ entity_type: 'unknown', text_value: '[4411]: hi | [9002]: hey' });
    expect((await nextItem(db, 1))?.text).toBe('[Speaker A]: hi | [Speaker B]: hey');
  });

  // "Deleted content" would tell the labeler someone already acted on it.
  it('names no content kind when the reported entity is gone', async () => {
    await seedItem({ entity_type: 'unknown' });
    expect((await nextItem(db, 1))?.entityLabel).toBeNull();
  });

  it('does not serve purged or expired text', async () => {
    await seedItem({ text_value: null });
    await seedItem({ purge_after: new Date('2020-01-01T00:00:00Z') });
    expect(await nextItem(db, 1)).toBeNull();
  });
});

describe('saveAnswer', () => {
  it('refuses an answer to purged text', async () => {
    const token = await seedItem({ text_value: null });
    expect(await save(1, token)).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses an answer to text past purge_after that is not yet purged', async () => {
    const token = await seedItem({ purge_after: new Date('2020-01-01T00:00:00Z') });
    expect(await save(1, token)).toEqual({ ok: false, reason: 'missing' });
  });

  // An edit after a hand-off was made with the report in view; the first hand-off time is what lets
  // the eval tell that edit from a blind label.
  it('keeps the first hand-off time through later edits', async () => {
    const token = await seedItem({ tag: 'CSAM' });
    await save(1, token, 'borderline');
    const handedOffAt = async () =>
      (await db.selectFrom('text_relabel_answer').select('handed_off_at').executeTakeFirstOrThrow())
        .handed_off_at;
    expect(await handedOffAt()).toBeNull();
    await save(1, token, 'clear_violation');
    expect(await handedOffAt()).not.toBeNull();
    // Pinned far in the past, so a re-stamp by a later save cannot land on the same instant.
    const first = new Date('2026-01-01T00:00:00Z');
    await db.updateTable('text_relabel_answer').set({ handed_off_at: first }).execute();
    await save(1, token, 'false_positive');
    await save(1, token, 'clear_violation');
    expect(new Date(String(await handedOffAt())).toISOString()).toBe(first.toISOString());
  });
});

describe('ownHandOffs', () => {
  // Decision: a clear violation on a hand-off tag is linked to the report and lookup pages; other
  // answers, and other labellers' answers, are not.
  it('lists only this labeler’s clear violations on hand-off tags', async () => {
    const csam = await seedItem({ tag: 'CSAM' });
    const grooming = await seedItem({ tag: 'Grooming' });
    const nsfw = await seedItem({ tag: 'NSFW' });
    const borderline = await seedItem({ tag: 'CSAM' });
    const otherLabeler = await seedItem({ tag: 'CSAM' });
    await save(1, csam, 'clear_violation');
    await save(1, grooming, 'clear_violation');
    await save(1, nsfw, 'clear_violation');
    await save(1, borderline, 'borderline');
    await save(2, otherLabeler, 'clear_violation');
    const handOffs = await ownHandOffs(db, 1);
    expect(handOffs.map((h) => h.token).sort()).toEqual([csam, grooming].sort());
    expect(handOffs.find((h) => h.token === csam)).toMatchObject({
      tag: 'CSAM',
      reportId: 1,
      entityType: 'commentV2',
      entityId: 10,
      authorId: 100,
    });
  });
});

describe('labelerProgress', () => {
  it('counts the labeler’s answers and how much of wave 1 has at least one label', async () => {
    const a = await seedItem();
    await seedItem();
    await seedItem({ wave: 2 });
    await save(1, a);
    expect(await labelerProgress(db, 1)).toEqual({ mine: 1, waveOne: 2, waveOneDone: 1 });
  });
});

import { describe, expect, it, vi } from 'vitest';

/**
 * `ModelNotes` has no owner id — `createdBy` is free text — so "edit your own note" is a predicate in
 * the UPDATE and nothing else. `isMine` on the read decides whether the edit link is offered, but it
 * is advice: the row id travels through a form, so dropping the author predicate would let any
 * moderator rewrite any note, including the imported ones, with the UI unchanged and every mocked test
 * still green.
 *
 * So the SQL is what these read. Its text is identical whatever the author is, so the text alone
 * cannot show the right value was bound — `capturingDb` records the parameters beside it.
 *
 * The audit rows matter for the same reason. The table has no `updatedAt`, so a rewritten note keeps
 * its original byline and date; `ModActivity` is the only record that the text changed, and it must
 * name the model the note is FILED against rather than one a form claimed.
 */

const sql = vi.hoisted(() => [] as string[]);
const params = vi.hoisted(() => [] as unknown[][]);
const rows = vi.hoisted(() => [] as unknown[]);
const activity = vi.hoisted(() => [] as unknown[]);

vi.mock('../moderator-db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(sql, rows, params);
  return { getModeratorDb: () => db };
});
vi.mock('../mod-activity', () => ({
  recordModActivity: (input: unknown) => {
    activity.push(input);
    return Promise.resolve();
  },
}));

const { addModelNote, getModelNotes, updateModelNote } = await import('../model-notes.service');

const reset = (canned: unknown[] = []) => {
  sql.length = 0;
  params.length = 0;
  activity.length = 0;
  rows.length = 0;
  rows.push(...canned);
};

const note = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  modelId: 555,
  content: 'seen this one before',
  createdBy: 'Logan',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  ...over,
});

describe('model notes', () => {
  it('scopes the edit to the note AND its author', async () => {
    reset([note()]);
    await updateModelNote({ id: 42, content: 'revised', author: 'briant', moderatorId: 9 });

    expect(sql[0]).toMatch(/update\s+"ModelNotes"/i);
    expect(sql[0]).toContain('"id" = ');
    expect(sql[0]).toContain('"createdBy" = ');
    expect(params[0]).toEqual(['revised', 42, 'briant']);
  });

  it('reports an edit that matched no row as a failure, and records nothing', async () => {
    reset();
    expect(
      await updateModelNote({ id: 42, content: 'revised', author: 'briant', moderatorId: 9 })
    ).toBe(false);
    expect(activity).toEqual([]);
  });

  it('files the edit against the model the note came back with, not one it was told', async () => {
    reset([note({ modelId: 777 })]);
    await updateModelNote({ id: 42, content: 'revised', author: 'briant', moderatorId: 9 });

    expect(sql[0]).toMatch(/returning\s+"modelId"/i);
    expect(activity).toEqual([
      { userId: 9, entityType: 'model', entityId: 777, activity: 'editNote' },
    ]);
  });

  it('attributes a new note to the moderator who wrote it, and records it', async () => {
    reset();
    await addModelNote({ modelId: 7, content: 'watch this one', author: 'briant', moderatorId: 9 });

    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/insert into\s+"ModelNotes"/i);
    expect(params[0]).toEqual([7, 'watch this one', 'briant']);
    expect(activity).toEqual([
      { userId: 9, entityType: 'model', entityId: 7, activity: 'addNote' },
    ]);
  });

  it('offers the edit link only on an exact author match', async () => {
    reset([note({ id: 1, createdBy: 'briant' }), note({ id: 2, createdBy: 'Logan' })]);
    const mine = await getModelNotes(7, 'briant');
    expect(mine.map((n) => n.isMine)).toEqual([true, false]);
  });

  it('claims nothing for a viewer with no username', async () => {
    reset([note({ createdBy: 'Logan' }), note({ id: 2, createdBy: '' })]);
    for (const viewer of [null, '']) {
      const seen = await getModelNotes(7, viewer);
      expect(seen.some((n) => n.isMine)).toBe(false);
    }
  });

  it('reads the newest note first', async () => {
    reset([note()]);
    await getModelNotes(7, 'briant');
    expect(sql[0]).toMatch(/order by\s+"createdAt"\s+desc/i);
  });
});

import { describe, expect, it, vi } from 'vitest';

/**
 * The sibling of `model-notes.test.ts`.
 *
 * `UserNotes.lastUpdateBy` is free text, so "edit your own note" is the `where` in the UPDATE and
 * nothing else. `isMine` on the read only decides whether the edit link is offered; the row id travels
 * through a form. Dropping the predicate would let any moderator rewrite any note with the UI
 * unchanged, and every mock in this app would stay green.
 */

const sql = vi.hoisted(() => [] as string[]);
const params = vi.hoisted(() => [] as unknown[][]);

vi.mock('../moderator-db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { getModeratorDb: () => capturingDb(sql, [], params) };
});
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));

const { addUserNote, updateUserNote } = await import('../moderation-memory.service');

const reset = () => {
  sql.length = 0;
  params.length = 0;
};

describe('user notes', () => {
  it('scopes the edit to the note AND its author', async () => {
    reset();
    await updateUserNote({ id: 42, notes: 'revised', author: 'briant' });

    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/update\s+"UserNotes"/i);
    expect(sql[0]).toContain('"id" = ');
    expect(sql[0]).toContain('"lastUpdateBy" = ');
    // The timestamp is `new Date()`, so its position is asserted and its value is not.
    expect(params[0]?.[0]).toBe('revised');
    expect(params[0]?.slice(2)).toEqual([42, 'briant']);
  });

  it('reports an edit that matched no row as a failure', async () => {
    reset();
    expect(await updateUserNote({ id: 42, notes: 'revised', author: 'briant' })).toBe(false);
  });

  it('attributes a new note to the moderator who wrote it', async () => {
    reset();
    await addUserNote({ userId: 7, notes: 'watch this one', author: 'briant' });

    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/insert into\s+"UserNotes"/i);
    expect(params[0]?.[0]).toBe(7);
    expect(params[0]?.[1]).toBe('watch this one');
    expect(params[0]?.[3]).toBe('briant');
  });
});

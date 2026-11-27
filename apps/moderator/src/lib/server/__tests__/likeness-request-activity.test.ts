import { describe, expect, it, vi } from 'vitest';

/**
 * A single-image block for a likeness/DMCA request leaves a `likenessRequest` ModActivity row on the
 * image (bulk removals get theirs from the main app's `/api/mod/remove-images`). The main app's
 * appeal-decision-records sweep deletes the image's appeal training copies by that row, so a
 * missing row keeps a copy Legal asked to have deleted.
 */

const { sql, params } = vi.hoisted(() => ({ sql: [] as string[], params: [] as unknown[][] }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb(sql, [], params), dbWrite: capturingDb(sql, [], params) };
});

const { recordLikenessRequest } = await import('../mod-activity');

describe('recordLikenessRequest', () => {
  it('writes the row the sweep reads: the image, under likenessRequest', async () => {
    await recordLikenessRequest(5, 11);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^insert into "ModActivity"/i);
    expect(params[0]).toEqual(expect.arrayContaining([5, 'image', 11, 'likenessRequest']));
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A removal for a likeness/DMCA request leaves a `likenessRequest` ModActivity row on the image. The
 * main app's appeal-decision-records sweep deletes the image's appeal training copies by that row, so
 * a missing row keeps a copy Legal asked to have deleted.
 */

const { sql, params } = vi.hoisted(() => ({ sql: [] as string[], params: [] as unknown[][] }));
const recordModActivity = vi.hoisted(() => vi.fn(async () => undefined));
const recordLikenessRequest = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb(sql, [], params), dbWrite: capturingDb(sql, [], params) };
});
vi.mock('../mod-activity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordModActivity,
  recordLikenessRequest,
}));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({ locals: {}, request: { headers: new Headers() } }),
}));

const { removeImages } = await import('../user-actions.service');
const actual = await vi.importActual<typeof import('../mod-activity')>('../mod-activity');

let held: number[];
beforeEach(() => {
  sql.length = 0;
  params.length = 0;
  held = [];
  recordModActivity.mockClear();
  recordLikenessRequest.mockClear();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const { imageIds } = JSON.parse(String(init.body)) as { imageIds: number[] };
    const heldHere = imageIds.filter((id) => held.includes(id));
    return new Response(
      JSON.stringify({
        images: imageIds.length - heldHere.length,
        held: heldHere.map((imageId) => ({
          imageId,
          created: true,
          approvedAt: '2026-11-01T00:00:00.000Z',
          approvedByUsername: null,
        })),
      }),
      { status: 200 }
    );
  });
});

describe('removeImages — likeness requests', () => {
  it('marks each removed image, and not one held for a second moderator', async () => {
    held = [12];

    const result = await removeImages({
      imageIds: [11, 12, 13],
      violationType: 'likenessRequest',
      moderatorId: 5,
    });

    expect(result.ok).toBe(true);
    expect(recordLikenessRequest.mock.calls).toEqual([
      [5, 11],
      [5, 13],
    ]);
  });

  it('marks nothing for any other reason', async () => {
    await removeImages({ imageIds: [11], violationType: 'realPerson', moderatorId: 5 });
    await removeImages({ imageIds: [11], violationType: 'other', moderatorId: 5 });

    expect(recordLikenessRequest).not.toHaveBeenCalled();
    expect(recordModActivity).toHaveBeenCalledTimes(2);
  });
});

describe('recordLikenessRequest', () => {
  it('writes the row the sweep reads: the image, under likenessRequest', async () => {
    await actual.recordLikenessRequest(5, 11);

    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^insert into "ModActivity"/i);
    expect(params[0]).toEqual(expect.arrayContaining([5, 'image', 11, 'likenessRequest']));
  });
});

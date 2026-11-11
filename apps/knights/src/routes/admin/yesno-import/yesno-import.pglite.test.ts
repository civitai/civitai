// Temporary: remove after the Knights v2 launch import
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const logToAxiom = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));

const { load } = await import('./+page.server');
const { POST } = await import('./+server');

const HEADER =
  'question_id,case_id,image_id,axis,kind,question,yes_effect,no_effect,active_candidate,source_batch_id,source_purpose,promotion_status,policy_sha256';
const line = (id: string, over: { image?: string; axis?: string } = {}) =>
  `${id},c1,${over.image ?? '10'},${
    over.axis ?? 'violence'
  },observable,"Is a hat, worn?",R4,R3,true,b1,audit,unadjudicated,abc`;

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  state.db = db;
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  logToAxiom.mockReset();
  await pg.exec(
    `TRUNCATE "KnightsQueueItem","KnightsVote","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
  await seedImage(pg, 10);
});

const count = async () =>
  Number((await pg.query<{ n: string }>(`SELECT count(*) AS n FROM "KnightsQueueItem"`)).rows[0].n);

const moderator = { id: 4, isModerator: true };
const post = async (user: unknown, payload: unknown) => {
  const response = await Promise.resolve(
    POST({
      request: new Request('http://knights.test/admin/yesno-import', {
        method: 'POST',
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
      locals: { user },
    } as never)
  ).catch((error: { status?: number }) => error);
  return response instanceof Response
    ? { status: response.status, body: await response.json() }
    : { status: response.status, body: null };
};

describe('moderator-only', () => {
  it.each([{ id: 7 }, { id: 7, isModerator: false }])(
    'refuses %o on load with 403',
    async (user) => {
      await expect(
        Promise.resolve().then(() => load({ locals: { user } } as never))
      ).rejects.toMatchObject({
        status: 403,
      });
    }
  );

  it('refuses a non-moderator POST with 403 and writes nothing', async () => {
    const result = await post({ id: 7 }, { csv: [HEADER, line('a')].join('\n'), dryRun: false });
    expect(result.status).toBe(403);
    expect(await count()).toBe(0);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('lets a moderator load the page', async () => {
    await expect(
      Promise.resolve(load({ locals: { user: moderator } } as never))
    ).resolves.toBeDefined();
  });
});

describe('POST /admin/yesno-import', () => {
  it('a dry run reports what it would import and writes nothing', async () => {
    const { status, body } = await post(moderator, {
      csv: [HEADER, line('a'), line('b'), line('c', { image: 'x' })].join('\n'),
      dryRun: true,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      read: 3,
      toImport: 2,
      skipped: { 'bad-image': 1 },
    });
    expect(body.result).toBeUndefined();
    expect(await count()).toBe(0);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('a real run writes the rows, returns the counts and logs the chunk', async () => {
    const csv = [HEADER, line('a'), line('b')].join('\n');
    const first = await post(moderator, { csv, dryRun: false });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, dryRun: false, read: 2, toImport: 2 });
    expect(first.body.result).toMatchObject({ inserted: 2, updated: 0, unchanged: 0 });
    expect(await count()).toBe(2);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'knights-yesno-import', userId: 4, read: 2, inserted: 2 })
    );

    const again = await post(moderator, { csv, dryRun: false });
    expect(again.body.result).toMatchObject({ inserted: 0, unchanged: 2 });
    expect(await count()).toBe(2);
  });

  it('a chunk with a bad row reports the skip and still imports the rest', async () => {
    const { status, body } = await post(moderator, {
      csv: [HEADER, line('a'), line('b', { axis: 'Bad Axis!' })].join('\n'),
      dryRun: false,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ read: 2, toImport: 1, skipped: { 'bad-axis': 1 } });
    expect(await count()).toBe(1);
  });

  it('rejects a malformed payload with 400', async () => {
    expect((await post(moderator, 'not json')).status).toBe(400);
    expect((await post(moderator, { csv: 5, dryRun: false })).status).toBe(400);
    expect((await post(moderator, { csv: HEADER })).status).toBe(400);
  });

  it('reports a database failure as a 500 without throwing', async () => {
    const saved = state.db;
    state.db = {
      insertInto: () => {
        throw new Error('boom');
      },
    };
    try {
      const { status, body } = await post(moderator, {
        csv: [HEADER, line('a')].join('\n'),
        dryRun: false,
      });
      expect(status).toBe(500);
      expect(body.ok).toBe(false);
    } finally {
      state.db = saved;
    }
  });
});

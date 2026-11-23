import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { runTagReview } from './tag-review';
import { createTagReviewPort, writeBackTagReviews } from './tag-writeback';
import { castYesNoVote } from './vote';

/** Shared setup of the tag review pglite suites (`createQueueDb` + `bootTagReview`). */

export const R = 4;
export const X = 16;
export const BLOCKED = 32;

/** Empties every table the suites write, and seeds the given tags as `[id, name, type, nsfwLevel]`. */
export async function resetTagReview(pg: PGlite, tags: [number, string, string, number][]) {
  await pg.exec(`
    TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay","Image","Post",
      "TagsOnImageNew","Tag","CsamReport","EvidenceHeldUser","Report","ImageReport" RESTART IDENTITY CASCADE;
    DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%';
  `);
  for (const [id, name, type, level] of tags)
    await pg.query(`INSERT INTO "Tag" (id, name, type, "nsfwLevel") VALUES ($1, $2, $3, $4)`, [
      id,
      name,
      type,
      level,
    ]);
}

/** An earlier vote by `playerId` keeps the Paladin stage staffed (`staffedRanks`). */
export const staffPaladin = (pg: PGlite, playerId: number, at: Date) =>
  pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict")
     VALUES (999999, $1, $2::timestamp, 'knights.image.nsfwLevel', 0, 'Paladin', '4', 1, 'pending')`,
    [playerId, at.toISOString()]
  );

/** Flagged for review and enabled, as the main app's downvote job leaves a tag. */
export const flagTag = (pg: PGlite, imageId: number, tagId: number) =>
  pg.query(`SELECT upsert_tag_on_image($1, $2, NULL, NULL, NULL, false, true)`, [imageId, tagId]);
/** Ruled: no longer flagged, and enabled (kept) or disabled (removed). */
export const ruleTag = (pg: PGlite, imageId: number, tagId: number, disabled: boolean) =>
  pg.query(`SELECT upsert_tag_on_image($1, $2, NULL, NULL, false, $3, false)`, [
    imageId,
    tagId,
    disabled,
  ]);

/** Creates the items for what is flagged now and casts `answers` on the first, players 1, 2, 3, ... in turn. */
export async function settledItem(
  db: Kysely<DB>,
  pg: PGlite,
  answers: ('yes' | 'no')[],
  now: Date
): Promise<number> {
  await runTagReview(db, { now, enabled: true, walk: { after: null } });
  const { rows } = await pg.query<{ id: number }>(`SELECT id FROM "KnightsQueueItem" ORDER BY id`);
  const id = rows[0].id;
  for (const [i, answer] of answers.entries())
    await castYesNoVote(db, { userId: i + 1, itemId: id, answer }, { now: () => now });
  return id;
}

/** The moderator app over HTTP, faked at `fetch`: the only thing these suites fake. */
export function fakeModerator() {
  const state = {
    calls: [] as { url: string; body: Record<string, unknown> }[],
    answer: (() => Response.json({ ok: true, result: { outcome: 'applied' } })) as () =>
      | Response
      | Promise<Response>,
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    state.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return state.answer();
  };
  return { state, fetch };
}

export const answering = (outcome: string) => () =>
  Response.json({ ok: true, result: { outcome } });

export type WriteBackOptions = {
  at: Date;
  enabled?: boolean;
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
};

/** One write-back pass through the real port and client, against the fake moderator app. */
export const writeBackWith = (
  db: Kysely<DB>,
  fetch: typeof globalThis.fetch,
  o: WriteBackOptions
) =>
  writeBackTagReviews(
    db,
    createTagReviewPort({
      endpoint: 'endpoint' in o ? o.endpoint : 'http://moderator.test',
      token: 'token' in o ? o.token : 'scoped-token',
      fetch,
      timeoutMs: o.timeoutMs,
    }),
    { now: o.at, enabled: o.enabled ?? true }
  );

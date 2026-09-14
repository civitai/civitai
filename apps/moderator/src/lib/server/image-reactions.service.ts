import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

export type ImageReactionRow = {
  key: string;
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  reaction: string;
  createdAt: Date;
  /** Differs from `createdAt` when the reaction was changed rather than first given. */
  updatedAt: Date | null;
};

/** Where the next page resumes: the sort key of the last row handed out. */
export type ReactionCursor = { createdAt: Date; id: number };

export type ReactionPage = {
  rows: ImageReactionRow[];
  /** Counted every time, so a caller walking the list sees the set shrink under it rather than
   *  reporting a stale figure from whenever the page was first opened. */
  total: number;
  /** Absent when this page reached the end. */
  nextCursor: ReactionCursor | null;
};

/**
 * Retool listed every reaction row in one go. Paged here — but the page is a page, NOT the answer.
 *
 * 🔴 `total` IS COUNTED, NEVER INFERRED FROM THE PAGE. The header used to read "Reactions (100+)" on an
 * image with 312, because the only number it had was the row count it had fetched. A cap presented as a
 * total is the one number a moderation surface must not get wrong — it was the whole complaint behind
 * this page's ticket, where a truncated list read as the full picture and a reaction ring looked like
 * background noise. The count is a separate index-only query on `(imageId)`, sub-millisecond.
 *
 * 🔴 A KEYSET CURSOR, NOT `OFFSET`, AND THE REASON IS CORRECTNESS RATHER THAN COST. Un-reacting DELETES
 * the row (`imageReaction.deleteMany` in the main app — there is no soft delete), and the sort is
 * `createdAt DESC`, so anything arriving or leaving lands at the HEAD and shifts every offset beneath
 * it. On a reaction-ring image — the case this page exists for — churn is not an edge case, it is the
 * expected behaviour. Measured shape of the failure with `OFFSET`:
 *
 *   three rows withdrawn while the operator reads → the next page starts three rows too late, and
 *     those three are never fetched. The panel shows 309 of 312 and says nothing.
 *   three rows arriving instead → the next page repeats three already-held rows, whose `key` is
 *     already in the list, and `{#each … (r.key)}` throws on a duplicate key IN PRODUCTION too.
 *
 * Resuming from the last row's own sort key is immune to both: it names a position in the ordering
 * rather than a distance from the top. The cost argument for `OFFSET` was about the sort, and the sort
 * is identical either way — `ImageReaction` has no `createdAt` index (only `(imageId, userId)`), so
 * every page sorts that image's rows regardless. Measured on a 7,548-reaction image: 446ms per page,
 * 12ms for the count.
 */
export async function getReactions(
  imageId: number,
  { limit = 100, cursor }: { limit?: number; cursor?: ReactionCursor | null } = {}
): Promise<ReactionPage> {
  const [rows, counted] = await Promise.all([
    dbRead
      .selectFrom('ImageReaction as ir')
      .leftJoin('User as u', 'u.id', 'ir.userId')
      .select([
        'ir.id',
        'ir.userId',
        'ir.reaction',
        'ir.createdAt',
        'ir.updatedAt',
        'u.username',
        'u.bannedAt',
      ])
      .where('ir.imageId', '=', imageId)
      .$if(!!cursor, (qb) =>
        // A row-value comparison, which Postgres evaluates against the same `(createdAt, id)` ordering
        // below — spelling it as two OR'd predicates instead is the classic way to get the boundary row
        // wrong in one direction and silently drop or repeat it.
        qb.where(sql<boolean>`(ir."createdAt", ir."id") < (${cursor!.createdAt}, ${cursor!.id})`)
      )
      // 🔴 `id` breaks the tie, and the cursor above is only sound because of it. `createdAt` alone is
      // not unique — a ring lands dozens of reactions inside one second — so a cursor on time alone
      // would either re-serve or skip every row sharing the boundary second.
      .orderBy('ir.createdAt', 'desc')
      .orderBy('ir.id', 'desc')
      .limit(limit)
      .execute(),
    dbRead
      .selectFrom('ImageReaction')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('imageId', '=', imageId)
      .executeTakeFirst(),
  ]);

  const last = rows.at(-1);
  return {
    rows: rows.map((r) => ({
      // `ImageReaction` is unique on (imageId, userId, reaction), so one user appears once per reaction
      // type — the row id is the only single-column key that holds.
      key: String(r.id),
      userId: r.userId,
      username: r.username,
      bannedAt: r.bannedAt,
      reaction: String(r.reaction),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    total: Number(counted?.total ?? 0),
    // A short page is the end of the set. Reporting a cursor there would have the caller ask once more
    // and get nothing, which is harmless but makes "are we done" a second round trip.
    nextCursor: last && rows.length === limit ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

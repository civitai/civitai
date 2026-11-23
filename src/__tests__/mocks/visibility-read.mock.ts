import { Prisma } from '@prisma/client';

/** What the visibility read asked for, read back from its SQL. */
export type VisibilityRead = { ids: number[]; userId?: number; isModerator?: boolean };

/**
 * A `$queryRaw` implementation that answers `getImageIdsVisibleToViewer`'s query with the ids
 * `decide` returns, for a test that stubs the database instead of mocking that function (whose
 * callers in its own module a mock cannot reach). `decide` gets the ids from `i.id IN (…)` and the
 * viewer: a moderator's read carries no visibility conditions; any other read names the viewer in
 * `i."userId" = …` (`isModerator` is `false` when signed in, `undefined` when signed out). Other
 * raw reads get no rows; an image read missing those markers throws, so a reworded query fails
 * the suite instead of reading as "nothing visible".
 */
export function answerVisibilityRead(decide: (read: VisibilityRead) => Promise<Set<number>>) {
  return async (strings: TemplateStringsArray, ...values: Prisma.Sql[]) => {
    const query = Prisma.sql(strings, ...values);
    if (!query.text.includes('FROM "Image" i')) return [];
    const idList = query.text.match(/i\.id IN \(([^)]*)\)/)?.[1];
    const conditions = query.text.includes('"needsReview" IS NULL');
    const userParam = query.text.match(/i\."userId" = (\$\d+)/)?.[1];
    if (
      !query.text.includes('LEFT JOIN "Post" p ON p.id = i."postId"') ||
      idList === undefined ||
      (conditions && userParam === undefined)
    )
      throw new Error(`answerVisibilityRead cannot read this image query:\n${query.text}`);

    const param = (placeholder: string) => query.values[Number(placeholder.slice(1)) - 1];
    const ids = (idList.match(/\$\d+/g) ?? []).map((p) => param(p) as number);
    const userId = userParam ? (param(userParam) as number | undefined) : undefined;
    const visible = await decide({
      ids,
      userId,
      isModerator: !conditions || (userId === undefined ? undefined : false),
    });
    return [...visible].map((id) => ({ id, userId: 0 }));
  };
}

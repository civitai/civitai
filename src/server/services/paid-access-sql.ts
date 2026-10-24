import { Prisma } from '@prisma/client';

/**
 * "This gate is live right now" — `isPaidAccessActive` from @civitai/buzz expressed in SQL, plus the
 * published-version scope every model-level consumer needs. Assumes the query joins `PaidAccess pa`
 * to `ModelVersion mv`.
 *
 * ONE copy, deliberately, and a leaf so wanting the predicate does not drag a service's import graph
 * along with it. This rule was written out four separate times across two services before 868m1r2u7,
 * and the guard meant to stop a fifth could not see two of them: it exempted a whole file by name and
 * counted one table alias. Interpolate this instead of restating it — then there is no copy to miss.
 *
 * 🔴 What this does NOT close: whether this SQL still agrees with `isPaidAccessActive`, the TypeScript
 * predicate the same rule is evaluated by elsewhere. Extraction makes the SQL sites agree by
 * construction; SQL-vs-TS is now the only way the paid filter and the paid badge can disagree, and
 * nothing in the unit suite executes SQL. Change one, re-read the other.
 */
export const paidAccessLiveSql = Prisma.sql`pa."entityType" = 'ModelVersion'
      AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())
      AND mv.status = 'Published'::"ModelStatus"`;

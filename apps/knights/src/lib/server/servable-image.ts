import { sql, type ExpressionBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import * as shared from '@civitai/shared';

// tsx loads CommonJS-scoped workspace packages as one `default` object when an ES module imports them.
const { NsfwLevel } = (shared as { default?: typeof shared }).default ?? shared;

type Joined = DB & { img: DB['Image']; p: DB['Post'] };

/**
 * Images the public feeds would show: a published post, a rated image with no block marker and
 * no review hold. Expects `Image as img` joined to `Post as p`.
 */
export const servableImage = (eb: ExpressionBuilder<Joined, 'img' | 'p'>) =>
  eb.and([
    eb('img.type', '=', 'image'),
    eb('img.nsfwLevel', 'not in', [0, NsfwLevel.Blocked]),
    eb('img.ingestion', '!=', 'Blocked'),
    eb('img.blockedFor', 'is', null),
    eb('img.needsReview', 'is', null),
    eb('img.acceptableMinor', '=', false),
    eb('p.publishedAt', 'is not', null),
    eb('p.publishedAt', '<', sql<Date>`(now() AT TIME ZONE 'utc')`),
  ]);

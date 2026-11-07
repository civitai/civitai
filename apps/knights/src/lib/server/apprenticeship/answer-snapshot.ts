import { sql, type SqlBool } from 'kysely';

/**
 * The image and question an answer was given for. Read from the answer's own snapshot, falling back to the live
 * reference for answers stored before the snapshot columns existed. Expects the aliases `a` (the answer) and
 * `r` / `y` (its rating / yes/no reference, left-joined).
 */
export const answerImageId = sql<number>`COALESCE(a."imageId", r."imageId", y."imageId")`;
export const answerQuestionKey = sql<string>`COALESCE(a."questionKey", r."questionKey", y."questionKey")`;

export const answerImageJoin = sql<SqlBool>`img."id" = ${answerImageId}`;

/** A yes/no pair's own question; null when it has none or only whitespace. Expects the alias `y`. */
export const ownPairPrompt = sql<string | null>`NULLIF(btrim(y."prompt"), '')`;

/** The question an Acolyte is asked about a pair: its own, else the axis question's. Expects `y` and `q`. */
export const pairPrompt = sql<string>`COALESCE(${ownPairPrompt}, q."prompt")`;

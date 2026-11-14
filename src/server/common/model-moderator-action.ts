/**
 * Whether a moderator acted on a model, as SQL over the "Model" row aliased `m`. Read by the creator
 * score (`update-user-score.ts`) and the old-drafts keep rule (`draft-keep.ts`). Plain strings with no
 * parameters, so either a tagged template or a string query can use them.
 */

const alias = (m: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(m)) throw new Error(`Bad table alias: ${m}`);
  return m;
};

/** Unpublished by anyone but its owner. A missing actor counts as the owner: nothing shows a
 *  moderator acted. */
export function unpublishedByOtherSql(model: string): string {
  const m = alias(model);
  return `COALESCE(${m}.meta->>'unpublishedBy' <> ${m}."userId"::text, false)`;
}

/** Whether the model's status when it was deleted is recorded (`recordStatusAtDelete`). */
export function statusAtDeleteKnownSql(model: string): string {
  return `${alias(model)}.meta ? 'statusAtDelete'`;
}

/**
 * Whether a moderator had already taken the model down when it was deleted: unpublished for a
 * violation, or unpublished by someone other than its owner. Where the delete recorded no
 * `statusAtDelete`, the takedown marks it left in `meta` decide.
 */
export function moderatorActedBeforeDeleteSql(model: string): string {
  const m = alias(model);
  return `(CASE WHEN ${statusAtDeleteKnownSql(m)}
    THEN ${m}.meta->>'statusAtDelete' = 'UnpublishedViolation'
      OR (${m}.meta->>'statusAtDelete' = 'Unpublished' AND ${unpublishedByOtherSql(m)})
    ELSE ${m}.meta ? 'unpublishedReason' OR ${unpublishedByOtherSql(m)}
  END)`;
}

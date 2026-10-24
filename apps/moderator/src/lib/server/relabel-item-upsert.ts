/**
 * Adds one sampled image to the relabel set, as `pg` positional SQL for `build-set.ts`.
 *
 * A labeler build ($13 = true) that samples an image already present as model-only promotes that
 * row and REWRITES its sampling fields: the stored row describes the image as it was when the
 * model-only build ran, and it may have been removed, restored or rescanned since. A model-only
 * build never touches an existing row. `inserted` is false for a promotion.
 */
export const UPSERT_RELABEL_ITEM_SQL = `
  INSERT INTO relabel_item
    (batch, image_id, stratum, bucket, nsfw_level, stratum_key, owner_id, removed_at, removed_by,
     purge_after, appeal_status, appeal_resolved_at, relabel)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (image_id) DO UPDATE SET
    batch = EXCLUDED.batch,
    stratum = EXCLUDED.stratum,
    bucket = EXCLUDED.bucket,
    nsfw_level = EXCLUDED.nsfw_level,
    stratum_key = EXCLUDED.stratum_key,
    owner_id = EXCLUDED.owner_id,
    removed_at = EXCLUDED.removed_at,
    removed_by = EXCLUDED.removed_by,
    purge_after = EXCLUDED.purge_after,
    appeal_status = EXCLUDED.appeal_status,
    appeal_resolved_at = EXCLUDED.appeal_resolved_at,
    relabel = true
  WHERE EXCLUDED.relabel AND NOT relabel_item.relabel
  RETURNING (xmax = 0) AS inserted
`;

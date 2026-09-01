-- BitDex decommission, phase 1 of 2: stop the ops write path.
--
-- BitDex is being replaced by a Postgres-backed single-table image index, and it
-- already serves no traffic — the `bitdex-image-search` flag resolves to `off` for
-- every segment. These eight triggers fire on write to eight of the hottest tables
-- in the database and append rows to "BitdexOps" at ~3,219 rows/min (~4.6M/day,
-- measured on the prod replica 2026-09-01).
--
-- Phase 1 drops only the triggers, not the functions or the tables. That is
-- deliberate and the ordering is load-bearing:
--
--   * `trg_cleanup_bitdex_ops` on `bitdex_cursors` is what DELETES consumed ops, and
--     it runs when the BitDex engine advances its cursor. It is left in place here so
--     the ~152K-row backlog drains itself once these triggers stop feeding it.
--   * Dropping these triggers while the engine is still up is safe: the engine simply
--     sees no new ops. Tearing the engine down FIRST is what is unsafe — the drain
--     stops and "BitdexOps" then grows without limit.
--
-- Phase 2 (separate migration, after the engine is torn down and the app code that
-- calls bitdex_post_fanout_ops / bitdex_image_sortat_ops is removed) drops the
-- functions, the cursor trigger, and the five bitdex_* tables.
--
-- NOT touched, and must not be: `image_sort_at_before` and `post_published_at_change`
-- maintain the real `Image."sortAt"` column and are unrelated to BitDex despite
-- sitting on the same two tables.

DROP TRIGGER IF EXISTS bitdex_image_45edf6c8 ON "Image";
DROP TRIGGER IF EXISTS bitdex_imageresourcenew_d84d15a8 ON "ImageResourceNew";
DROP TRIGGER IF EXISTS bitdex_imagetechnique_ee2b2860 ON "ImageTechnique";
DROP TRIGGER IF EXISTS bitdex_imagetool_f87e1fc4 ON "ImageTool";
DROP TRIGGER IF EXISTS bitdex_model_a13d0fe3 ON "Model";
DROP TRIGGER IF EXISTS bitdex_modelversion_22dd59b3 ON "ModelVersion";
DROP TRIGGER IF EXISTS bitdex_post_54f0a619 ON "Post";
DROP TRIGGER IF EXISTS bitdex_tagsonimagenew_bcbef3c3 ON "TagsOnImageNew";

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
--
-- 🔴 Each DROP takes an ACCESS EXCLUSIVE lock on its table, and four of these are
-- "Image", "Post", "ModelVersion" and "TagsOnImageNew" — among the hottest tables on
-- the site. The drop itself is instant; ACQUIRING the lock is not. It waits behind
-- every in-flight query on that table and, while it waits, queues in front of all new
-- traffic to it, so one slow feed query turns this into a site-wide write stall.
--
-- Hence the per-statement `lock_timeout`: failing fast and retrying costs nothing,
-- queueing costs the site. Same shape as the 20260827150000_thread_mute FK adds.
--
-- Apply these ONE STATEMENT AT A TIME and read each result. A multi-statement run
-- through the postgres-query skill prints a formatter error and applies anyway, so its
-- exit status cannot tell you whether the set is half-applied.

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_image_45edf6c8 ON "Image";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_imageresourcenew_d84d15a8 ON "ImageResourceNew";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_imagetechnique_ee2b2860 ON "ImageTechnique";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_imagetool_f87e1fc4 ON "ImageTool";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_model_a13d0fe3 ON "Model";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_modelversion_22dd59b3 ON "ModelVersion";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_post_54f0a619 ON "Post";
END $$;

DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS bitdex_tagsonimagenew_bcbef3c3 ON "TagsOnImageNew";
END $$;

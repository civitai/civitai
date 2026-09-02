-- BitDex decommission, phase 2 of 2: remove the objects themselves.
--
-- 🔴 DO NOT APPLY THIS BEFORE ALL THREE OF THESE ARE TRUE:
--   1. the BitDex ingest engine is gone from the cluster (talos-infra PRs 1373 -> 1374),
--      so nothing is writing `bitdex_cursors` and nothing is reading "BitdexOps";
--   2. the app code calling `bitdex_post_fanout_ops` / `bitdex_image_sortat_ops` is
--      removed -- as of writing that is `src/server/jobs/reemit-bitdex-ops.ts` and
--      nothing else (both are flag-gated off, so the call is unreachable, but the file
--      still names the functions);
--   3. the `bitdex` Postgres login role has NOT yet been dropped. Drop it AFTER this
--      migration, never before -- a role drop with dependent objects fails noisily.
--
-- Phase 1 (20260901190000_drop_bitdex_write_triggers) already removed the 8 write
-- triggers, applied to prod 2026-09-01 ~18:56Z.
--
-- "BitdexOps" is deliberately NON-EMPTY at drop time -- 124,020 rows as of 2026-09-01.
-- That is not unfinished work. Its reaper, `cleanup_bitdex_ops`, fires only on a write
-- to `bitdex_cursors`, and the only writer is the engine advancing its cursor; once the
-- writers stopped the engine caught up and stopped writing, so the backlog can never
-- reach zero on its own. Verified consumed: max("BitdexOps".id) = 264638333 equals
-- min(last_outbox_id) across both cursors exactly. Nothing is lost by dropping it.
--
-- Same per-statement `lock_timeout` reasoning as phase 1, and the same instruction:
-- apply ONE STATEMENT AT A TIME and read each result. A multi-statement run through the
-- postgres-query skill prints a formatter error and applies anyway, so its exit status
-- cannot tell you whether the set is half-applied.
--
-- Every name below was generated from the live prod catalog (pg_proc /
-- pg_get_function_identity_arguments, pg_class), not hand-typed.

-- The drain trigger. Last BitDex trigger in the database; phase 1 kept it so the
-- backlog could drain as far as it could.
DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TRIGGER IF EXISTS trg_cleanup_bitdex_ops ON bitdex_cursors;
END $$;

-- 27 functions. All but `cleanup_bitdex_ops` already have zero trigger references;
-- several are orphans from earlier trigger generations (the hash suffixes).
DROP FUNCTION IF EXISTS public.bitdex_collection_notify();
DROP FUNCTION IF EXISTS public.bitdex_image_notify();
DROP FUNCTION IF EXISTS public.bitdex_image_ops_085c2a3b();
DROP FUNCTION IF EXISTS public.bitdex_image_ops_45edf6c8();
DROP FUNCTION IF EXISTS public.bitdex_image_ops_8905b723();
DROP FUNCTION IF EXISTS public.bitdex_image_ops_a6ea374e();
DROP FUNCTION IF EXISTS public.bitdex_image_ops_dda29cf8();
DROP FUNCTION IF EXISTS public.bitdex_image_ops_ee936694();
DROP FUNCTION IF EXISTS public.bitdex_image_sortat_ops(_i "Image");
DROP FUNCTION IF EXISTS public.bitdex_imageresourcenew_ops_d84d15a8();
DROP FUNCTION IF EXISTS public.bitdex_imagetechnique_ops_ee2b2860();
DROP FUNCTION IF EXISTS public.bitdex_imagetool_ops_f87e1fc4();
DROP FUNCTION IF EXISTS public.bitdex_model_notify();
DROP FUNCTION IF EXISTS public.bitdex_model_ops_a13d0fe3();
DROP FUNCTION IF EXISTS public.bitdex_modelversion_ops_22dd59b3();
DROP FUNCTION IF EXISTS public.bitdex_mv_notify();
DROP FUNCTION IF EXISTS public.bitdex_post_fanout_ops(_p "Post");
DROP FUNCTION IF EXISTS public.bitdex_post_notify();
DROP FUNCTION IF EXISTS public.bitdex_post_ops_519ce657();
DROP FUNCTION IF EXISTS public.bitdex_post_ops_54f0a619();
DROP FUNCTION IF EXISTS public.bitdex_post_ops_8511462a();
DROP FUNCTION IF EXISTS public.bitdex_post_ops_98877f0f();
DROP FUNCTION IF EXISTS public.bitdex_tagsonimagenew_ops_bcbef3c3();
DROP FUNCTION IF EXISTS public.bitdex_trap_capture_row();
DROP FUNCTION IF EXISTS public.bitdex_trap_tick();
DROP FUNCTION IF EXISTS public.cleanup_bitdex_ops();
DROP FUNCTION IF EXISTS public.cleanup_bitdex_outbox();

-- The five tables. Dropped last so a failed function drop above does not leave a
-- table with no way to inspect what referenced it.
DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TABLE IF EXISTS "BitdexOps";
END $$;
DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TABLE IF EXISTS bitdex_cursors;
END $$;
DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TABLE IF EXISTS bitdex_fanout_capture;
END $$;
DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TABLE IF EXISTS bitdex_post_publish_capture;
END $$;
DO $$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP TABLE IF EXISTS bitdex_zm_log;
END $$;

-- Limit EXECUTE on two owner-rights helper functions to the roles that call them. Applied on prod
-- 2026-10-25.
--
-- get_replication_status() is read by the app through dbWrite (checkNotUpToDate in
-- packages/civitai-db/src/kv-helpers.ts). That call swallows errors and reports "not up to date",
-- so a caller left without EXECUTE sends every read to the primary instead of failing.
-- refresh_covered_checkpoint_details() has no caller: its materialized view was dropped by
-- 20250320124141_remove_checkpoint_details.
--
-- Functions and roles a database does not have (local and preview databases) are skipped.
DO $$
DECLARE
  r text;
BEGIN
  IF to_regprocedure('public.get_replication_status()') IS NOT NULL THEN
    FOREACH r IN ARRAY ARRAY['dp_prod_web', 'civitai-app-writer'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_replication_status() TO %I', r);
      END IF;
    END LOOP;
    REVOKE EXECUTE ON FUNCTION public.get_replication_status() FROM PUBLIC;
  END IF;

  IF to_regprocedure('public.refresh_covered_checkpoint_details()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.refresh_covered_checkpoint_details() FROM PUBLIC;
  END IF;
END $$;

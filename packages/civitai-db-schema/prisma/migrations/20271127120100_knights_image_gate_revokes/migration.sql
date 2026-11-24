-- Least-privilege cleanup for the Knights app's database role: revokes its privileges on tables it no longer uses now
-- that it reads "KnightsImageGate", and an UPDATE it never used, then checks it holds SELECT on none of them.
--
-- Apply MANUALLY, per environment, once the Knights release that reads "KnightsImageGate" is live, together with the
-- grant reconciler's matrix change for these tables. Apply as the owner of these tables. Re-runnable; a table this
-- environment lacks is skipped. Fails, changing nothing, if the role still holds SELECT on one of them (through a role
-- it belongs to or a PUBLIC grant).

BEGIN;

DO $$
DECLARE
  relation text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'knights_app') THEN
    RETURN;
  END IF;
  FOREACH relation IN ARRAY ARRAY[
    'CsamReport', 'BlockedImage',
    'ScanLabelItem', 'ScanLabelFlag', 'ScanLabelVote', 'Model', 'ModelVersion', 'TextScanHold',
    'ImageCdnModeratorDelete', 'UserReport', 'ModelReport', 'PostReport', 'Appeal', 'ImageFlag',
    'ImageResourceNew', 'CollectionItem', 'pg_stat_statements', 'pg_stat_statements_info'
  ] LOOP
    IF to_regclass(format('public.%I', relation)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM knights_app', relation);
    END IF;
  END LOOP;
  IF to_regclass('public."KnightsInquisitorVote"') IS NOT NULL THEN
    REVOKE UPDATE ON public."KnightsInquisitorVote" FROM knights_app;
  END IF;
  -- Every table above but the pg_stat_statements views, which PUBLIC may read wherever the extension is installed.
  FOREACH relation IN ARRAY ARRAY[
    'CsamReport', 'BlockedImage',
    'ScanLabelItem', 'ScanLabelFlag', 'ScanLabelVote', 'Model', 'ModelVersion', 'TextScanHold',
    'ImageCdnModeratorDelete', 'UserReport', 'ModelReport', 'PostReport', 'Appeal', 'ImageFlag',
    'ImageResourceNew', 'CollectionItem'
  ] LOOP
    IF to_regclass(format('public.%I', relation)) IS NOT NULL
       AND has_table_privilege('knights_app', format('public.%I', relation), 'SELECT') THEN
      RAISE EXCEPTION 'knights_app still holds SELECT on %; revoke the grant it inherits', relation;
    END IF;
  END LOOP;
END
$$;

COMMIT;

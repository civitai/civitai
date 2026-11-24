-- Takes back from the Knights app's database role the tables "KnightsImageGate" replaces, and an UPDATE it never uses.
--
-- Apply MANUALLY, per environment, only once the Knights release that reads "KnightsImageGate" is live (the release
-- before it still reads "CsamReport" and "EvidenceHeldUser"), and together with the grant reconciler's matrix change
-- that stops granting these, or the next reconciler run grants them back. Apply as the owner of these tables.
-- Re-runnable; a table this environment lacks is skipped.

BEGIN;

DO $$
DECLARE
  relation text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'knights_app') THEN
    RETURN;
  END IF;
  FOREACH relation IN ARRAY ARRAY[
    'CsamReport', 'EvidenceHeldUser', 'EvidenceHoldImage', 'EvidenceHoldPost', 'BlockedImage',
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
END
$$;

COMMIT;

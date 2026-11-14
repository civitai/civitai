-- MANUAL-APPLY. Copies a deleted ModelFile's scan verdict into the VaultItem entries that hold it.
-- Row trigger, so it also fires for files removed by a ModelVersion or Model cascade.
-- Apply by hand AFTER the code deploys (CLAUDE.md -> Database).

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.vault_item_snapshot_file_scan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Only the entry with this file's id changes; the others keep their order.
  UPDATE "VaultItem" vi
  SET files = (
    SELECT jsonb_agg(
      CASE WHEN t.e ->> 'id' = OLD.id::text
        THEN t.e || jsonb_build_object(
          'pickleScanResult', OLD."pickleScanResult",
          'virusScanResult', OLD."virusScanResult",
          'rowDeletedAt', to_jsonb(now())
        )
        ELSE t.e
      END
      ORDER BY t.ord
    )
    FROM jsonb_array_elements(vi.files) WITH ORDINALITY AS t(e, ord)
  )
  WHERE vi."modelVersionId" = OLD."modelVersionId"
    AND jsonb_typeof(vi.files) = 'array'
    AND vi.files @> jsonb_build_array(jsonb_build_object('id', OLD.id));
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS "ModelFile_vault_snapshot_scan" ON "ModelFile";
CREATE TRIGGER "ModelFile_vault_snapshot_scan"
  AFTER DELETE ON "ModelFile"
  FOR EACH ROW
  EXECUTE FUNCTION public.vault_item_snapshot_file_scan();

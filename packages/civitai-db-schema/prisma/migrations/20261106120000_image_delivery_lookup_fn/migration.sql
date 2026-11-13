-- image_delivery_lookup(url): the image-delivery row for one image url. The same rule the internal
-- image-delivery endpoint applies inline (`imageDeliveryStatement` in
-- src/server/services/image-delivery.service.ts), as a function a service can be granted EXECUTE on
-- without any privilege on "Image". The two are pinned to the same rows by
-- src/server/services/__tests__/image-delivery-lookup-fn.parity.pg.test.ts: change one, change both.
--
-- Apply this MANUALLY, per environment. We do not use `prisma migrate deploy` anywhere; this file
-- exists for review and history. Re-runnable: CREATE OR REPLACE, and REVOKE/GRANT are idempotent.
--
-- The rule, unchanged from the endpoint's statement:
--   * the url matches EXACTLY (case- and whitespace-sensitive);
--   * a row whose source is known gone (ingestion NotFound) is left out unless it hides its
--     metadata, so the caller checks the original itself instead of converting it;
--   * several rows can share a url (a copied image keeps its source's url): the most restrictive
--     setting wins, hence ORDER BY "hideMeta" DESC. Rows that tie on "hideMeta" are unordered, as
--     they are in the endpoint's statement.
--
-- Privileges. SECURITY DEFINER, so a caller needs EXECUTE on this function and NO privilege on
-- "Image": it runs as the function's OWNER, which must be a role that can SELECT "Image". Apply it as
-- the owner of "Image" (from a superuser session: SET ROLE <that owner>; first). The file REFUSES to
-- run as a superuser, so the function can never be created owned by one. The
-- search_path is pinned and every name is schema-qualified, so a caller cannot point it at objects
-- of its own. EXECUTE is revoked from PUBLIC (functions are executable by PUBLIC by default), so
-- grant it to each role that calls it:
--   GRANT EXECUTE ON FUNCTION public.image_delivery_lookup(text) TO <role>;
-- A caller that has no USAGE on schema public also needs GRANT USAGE ON SCHEMA public TO <role>,
-- which lets it resolve names there and reads no table.
--
-- STABLE: it reads, never writes, so it runs on a read replica. STRICT: a NULL url returns no row,
-- as `url = NULL` does.
--
-- One transaction, so the function never exists with PUBLIC still holding EXECUTE.

BEGIN;

DO $$
BEGIN
    IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
        RAISE EXCEPTION 'apply as the owner of "Image" (SET ROLE <owner>), not a superuser';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.image_delivery_lookup(p_url text)
RETURNS TABLE (
    id integer,
    url text,
    "hideMeta" boolean,
    type public."MediaType",
    "mimeType" text
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT i.id, i.url, i."hideMeta", i.type, i."mimeType"
    FROM public."Image" i
    WHERE i.url = p_url
      AND NOT (i.ingestion = 'NotFound'::public."ImageIngestionStatus" AND NOT i."hideMeta")
    ORDER BY i."hideMeta" DESC
    LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.image_delivery_lookup(text) FROM PUBLIC;

COMMIT;

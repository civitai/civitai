-- Handlers that read non-PK columns from a delete's before-image need REPLICA IDENTITY FULL: DEFAULT
-- ships only the primary key, so the fields are undefined and the delete silently skips its decrement.
--
-- Run it whole, as the publication's owner (psql -v ON_ERROR_STOP=1 -f). It is one transaction: if
-- the check at the end fails, nothing is applied. A rerun locks only the tables whose setting changes.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Postgres 18 refuses every UPDATE and DELETE on a published FULL table whose stored generated
-- columns the publication leaves out (CommentV3: rootId, depth). Debezium's filtered mode adds
-- tables to this publication by itself, so this must precede any of them going FULL.
ALTER PUBLICATION debezium_publication SET (publish_generated_columns = stored);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ResourceReview',
    'BountyBenefactor',
    -- Reactions: an un-react must carry reaction, entityId and userId.
    'ImageReaction',
    'ArticleReaction',
    'BountyEntryReaction',
    'UserEngagement',         -- reads `type` (PK: userId,targetUserId)
    'TagEngagement',          -- reads `type` (PK: userId,tagId)
    'ComicProjectEngagement', -- reads `type`,`readChapters` (PK: userId,projectId)
    'CollectionContributor',  -- reads `permissions` (PK: userId,collectionId)
    'CollectionItem',         -- reads entity ids,addedById,status (PK: id)
    'Comment',                -- reads userId,modelId (PK: id)
    'CommentV2',              -- reads userId,threadId (PK: id)
    'CommentV3',              -- reads userId,entityType,entityId,deletedAt (PK: id)
    'Article',                -- reads status,userId (PK: id)
    'Bounty',                 -- reads userId (PK: id)
    'BountyEntry'             -- reads userId,bountyId (PK: id)
  ] LOOP
    IF (SELECT relreplident FROM pg_class WHERE oid = format('public.%I', t)::regclass) <> 'f' THEN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
    END IF;
  END LOOP;
END $$;

-- Refuse any FULL table with a stored generated column that a publication carrying it, or the one
-- Debezium may add it to, does not publish: every write to that table would fail.
DO $$
DECLARE blocked text;
BEGIN
  SELECT string_agg(DISTINCT format('%I (%s)', c.relname, p.pubname), ', ') INTO blocked
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attgenerated = 's' AND NOT a.attisdropped
  JOIN pg_publication p ON true
  LEFT JOIN pg_publication_tables pt
    ON pt.pubname = p.pubname AND format('%I.%I', pt.schemaname, pt.tablename)::regclass = c.oid
  WHERE c.relreplident = 'f'
    AND (
      (pt.pubname IS NOT NULL AND NOT a.attname = ANY (pt.attnames))
      OR (p.pubname = 'debezium_publication' AND p.pubgencols <> 's')
    );
  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION 'REPLICA IDENTITY FULL would refuse every UPDATE and DELETE on: %', blocked
      USING HINT = 'Publish the stored generated columns first (publish_generated_columns = stored).';
  END IF;
END $$;

COMMIT;

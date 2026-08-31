-- Generic "Feed" home block: renders a slice of an existing feed (images or models)
-- under a saved set of filters, with the same row/limit constraints Collection blocks
-- use. Adding the enum value is all the schema needs; the filters live in metadata.
--
-- Postgres disallows using a new enum value in the same transaction that adds it, so
-- this is deliberately its own migration — the block row that uses 'Feed' is inserted
-- by the next one.
ALTER TYPE "HomeBlockType" ADD VALUE IF NOT EXISTS 'Feed';

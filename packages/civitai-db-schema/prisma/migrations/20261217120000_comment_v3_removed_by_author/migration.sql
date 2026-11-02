-- A comment its author deleted while a legal hold kept it is hidden as a ToS violation instead, as
-- CommentV2 marks with `metadata.removedByAuthor` and Comment with its own column. The mark keeps a
-- moderator's ToS restore from republishing it. Apply before the article write flip deploys.

ALTER TABLE "CommentV3" ADD COLUMN IF NOT EXISTS "removedByAuthor" boolean NOT NULL DEFAULT false;

-- `Post.collectionId` records where a post was created, not who owns it. Cascading a collection
-- delete through it destroyed the posts of everyone who had entered a contest/challenge or
-- contributed to a collaborative collection, and `Image.postId` (ON DELETE SET NULL) then left
-- their images alive with no post — a 404 on the owner's own image, still served from the feed
-- index. `CollectionItem` is the membership join and keeps its CASCADE, which is correct: the
-- entry goes away with the collection, the entrant's post does not.
--
-- Safe to apply before or after the deploy: SET NULL is strictly weaker than CASCADE, and the
-- application already detaches posts ahead of every collection delete it owns. This closes the
-- paths it does NOT own — raw SQL, Retool, a future service, and the User -> Collection cascade.
--
-- HOW TO APPLY — the two blocks below must be run as written, and NOT wrapped in one transaction.
--
-- Post is ~24M rows / ~31GB. DROP + ADD NOT VALID are metadata-only, but both need ACCESS
-- EXCLUSIVE, so they are wrapped together: run separately, a DROP that commits before an ADD that
-- hits `lock_timeout` leaves the column with no foreign key at all. Inside one transaction they
-- hold the lock for milliseconds and cannot half-apply.
--
-- VALIDATE stays OUTSIDE that transaction. It scans the whole table (minutes) under SHARE UPDATE
-- EXCLUSIVE, which blocks neither reads nor writes — but inside the transaction above it would
-- inherit ACCESS EXCLUSIVE and block every read and write to "Post" for the length of the scan.
-- Existing rows already satisfy the constraint; this changes only the delete action. If VALIDATE
-- times out acquiring its lock, re-run it — it is a no-op on an already-valid constraint.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE "Post" DROP CONSTRAINT "Post_collectionId_fkey";

ALTER TABLE "Post" ADD CONSTRAINT "Post_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "Collection"("id")
  ON UPDATE CASCADE ON DELETE SET NULL
  NOT VALID;

COMMIT;

ALTER TABLE "Post" VALIDATE CONSTRAINT "Post_collectionId_fkey";

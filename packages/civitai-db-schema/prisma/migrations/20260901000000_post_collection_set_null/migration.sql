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
-- Post is ~24M rows / ~31GB, so the constraint is added NOT VALID (no scan, brief lock) and
-- validated separately under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
-- Existing rows already satisfy it — this changes only the delete action.

SET lock_timeout = '5s';

ALTER TABLE "Post" DROP CONSTRAINT "Post_collectionId_fkey";

ALTER TABLE "Post" ADD CONSTRAINT "Post_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "Collection"("id")
  ON UPDATE CASCADE ON DELETE SET NULL
  NOT VALID;

ALTER TABLE "Post" VALIDATE CONSTRAINT "Post_collectionId_fkey";

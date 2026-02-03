-- Make projectId optional so characters can exist in the user's library
ALTER TABLE "ComicCharacter" ALTER COLUMN "projectId" DROP NOT NULL;

-- Change cascade behavior: when project is deleted, set characters' projectId to null
-- (move to library) instead of deleting them
ALTER TABLE "ComicCharacter" DROP CONSTRAINT "ComicCharacter_projectId_fkey";
ALTER TABLE "ComicCharacter" ADD CONSTRAINT "ComicCharacter_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

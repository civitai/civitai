-- Make projectId optional so characters can exist in the user's library
ALTER TABLE "comic_characters" ALTER COLUMN "projectId" DROP NOT NULL;

-- Change cascade behavior: when project is deleted, set characters' projectId to null
-- (move to library) instead of deleting them
ALTER TABLE "comic_characters" DROP CONSTRAINT "comic_characters_projectId_fkey";
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "comic_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

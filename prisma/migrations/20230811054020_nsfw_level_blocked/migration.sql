-- AlterEnum
ALTER TYPE "NsfwLevel" ADD VALUE 'Blocked';

-- Update blocked tags
UPDATE "Tag" SET nsfw = 'Blocked' WHERE name IN ('self injury', 'hanging', 'hate symbols', 'nazi party', 'white supremacy', 'extremist');

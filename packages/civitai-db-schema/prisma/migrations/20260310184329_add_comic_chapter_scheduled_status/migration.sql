-- Add 'Scheduled' value to ComicChapterStatus enum
ALTER TYPE "ComicChapterStatus" ADD VALUE IF NOT EXISTS 'Scheduled';

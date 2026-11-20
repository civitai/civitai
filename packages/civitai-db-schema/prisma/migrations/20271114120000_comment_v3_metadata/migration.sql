-- A comment's server-built extras: a song's timed comment holds { "timestampSec": n }.
ALTER TABLE "CommentV3" ADD COLUMN "metadata" JSONB;

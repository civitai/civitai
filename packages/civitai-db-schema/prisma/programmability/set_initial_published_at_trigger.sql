-- Write-once "first published" anchor (Slice 0 of the paid-access refactor).
-- Captures publishedAt into initialPublishedAt the first time a row is published, and never
-- overwrites it afterwards -- so the anchor is stable even when publishedAt is later rewritten
-- (e.g. the process-ending-early-access resurface, or a comic Draft->republish). BEFORE so it
-- edits NEW directly with no recursive UPDATE. One function, one trigger per table.
CREATE OR REPLACE FUNCTION set_initial_published_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."initialPublishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL THEN
        NEW."initialPublishedAt" := NEW."publishedAt";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_set_initial_published_at_model_version
BEFORE INSERT OR UPDATE OF "publishedAt" ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION set_initial_published_at();
---
CREATE OR REPLACE TRIGGER trigger_set_initial_published_at_comic_chapter
BEFORE INSERT OR UPDATE OF "publishedAt" ON "ComicChapter"
FOR EACH ROW
EXECUTE FUNCTION set_initial_published_at();

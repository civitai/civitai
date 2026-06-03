CREATE OR REPLACE FUNCTION comic_chapter_early_access_ends_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."publishedAt" IS NOT NULL
        AND NEW."earlyAccessConfig" IS NOT NULL
        AND NEW."earlyAccessConfig"->>'timeframe' IS NOT NULL
        AND (NEW."earlyAccessConfig"->>'timeframe')::int > 0
    THEN
        NEW."earlyAccessEndsAt" := COALESCE(NEW."publishedAt", now()) + CONCAT(NEW."earlyAccessConfig"->>'timeframe', ' days')::interval;
        NEW."availability" := 'EarlyAccess';
    ELSE
        IF NEW."publishedAt" IS NOT NULL THEN
            NEW."earlyAccessEndsAt" := NULL;
            NEW."availability" := 'Public';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_comic_chapter_early_access_ends_at
BEFORE INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" ON "ComicChapter"
FOR EACH ROW
EXECUTE FUNCTION comic_chapter_early_access_ends_at();

CREATE OR REPLACE FUNCTION comic_chapter_early_access_ends_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."publishedAt" IS NOT NULL
        AND NEW."earlyAccessConfig" IS NOT NULL
        AND NEW."earlyAccessConfig"->>'timeframe' IS NOT NULL
        AND (NEW."earlyAccessConfig"->>'timeframe')::int > 0
    THEN
        UPDATE "ComicChapter"
        SET "earlyAccessEndsAt" = COALESCE(NEW."publishedAt", now()) + CONCAT(NEW."earlyAccessConfig"->>'timeframe', ' days')::interval,
            "availability" = 'EarlyAccess'
        WHERE "projectId" = NEW."projectId" AND "position" = NEW."position";
    ELSE
        IF NEW."publishedAt" IS NOT NULL
            THEN
                UPDATE "ComicChapter"
                SET "earlyAccessEndsAt" = NULL,
                    "availability" = 'Public'
                WHERE "projectId" = NEW."projectId" AND "position" = NEW."position";
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER trigger_comic_chapter_early_access_ends_at
AFTER INSERT OR UPDATE OF "earlyAccessConfig", "publishedAt" ON "ComicChapter"
FOR EACH ROW
EXECUTE FUNCTION comic_chapter_early_access_ends_at();

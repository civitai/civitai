-- Content urls an article holds without an Image row: deferred until the key's issuer can be read,
-- refused while it is someone other than the owner or editor.
CREATE TABLE "ArticleContentLinkHold" (
    "articleId" INTEGER NOT NULL,
    "deferred" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "refused" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "editorId" INTEGER NOT NULL,
    "deferredSince" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleContentLinkHold_pkey" PRIMARY KEY ("articleId")
);

CREATE INDEX "ArticleContentLinkHold_checkedAt_idx" ON "ArticleContentLinkHold"("checkedAt");

ALTER TABLE "ArticleContentLinkHold" ADD CONSTRAINT "ArticleContentLinkHold_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

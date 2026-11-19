-- AccessToken: a generic, revocable, expiring bearer link to one resource. First use is private
-- share links to draft articles (`resourceType = 'Article'`). Only the sha256 of the token is
-- stored. ArticleShareCheck: the content check a shared draft's read requires.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: a human runs this SQL on
-- each environment (preview / dev, then production).
--
-- DEPLOY ORDER: apply this BEFORE deploying the code that reads it. A new table has no readers on
-- the previous build, so applying early is safe. Deploying first breaks every save that changes a
-- Draft or Unpublished article's text, the scan-status read and text-scan submission for those
-- articles, and every share-link procedure, until it is applied.

CREATE TABLE "AccessToken" (
  "id" SERIAL NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" INTEGER NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdById" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccessToken_tokenHash_key" ON "AccessToken"("tokenHash");
CREATE INDEX "AccessToken_resourceType_resourceId_idx" ON "AccessToken"("resourceType", "resourceId");
CREATE INDEX "AccessToken_createdById_idx" ON "AccessToken"("createdById");

ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ArticleShareCheck" (
  "articleId" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "workflowId" TEXT,
  "textHash" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArticleShareCheck_pkey" PRIMARY KEY ("articleId")
);

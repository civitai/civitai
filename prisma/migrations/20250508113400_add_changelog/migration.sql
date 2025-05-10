CREATE TYPE "ChangelogType" AS ENUM (
  'Feature',
  'Bugfix',
  'Policy',
  'Update'
);

CREATE TABLE "Changelog"
(
  "id"          SERIAL          NOT NULL,
  "title"       TEXT            NOT NULL,
  "content"     TEXT            NOT NULL,
  "link"        TEXT,
  "cta"         TEXT,
  "effectiveAt" TIMESTAMP(3)    NOT NULL,
  "createdAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)    NOT NULL,
  "type"        "ChangelogType" NOT NULL,
  "tags"        TEXT[]          NOT NULL DEFAULT ARRAY []::text[],
  "disabled"    BOOLEAN         NOT NULL DEFAULT false,

  CONSTRAINT "Changelog_pkey" PRIMARY KEY ("id")
);

-- TODO trigram index?
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE INDEX "Changelog_effectiveAt_idx" ON "Changelog" ("effectiveAt");
CREATE INDEX "Changelog_title_content_idx" ON "Changelog" USING gin ("title", "content");
CREATE INDEX "Changelog_type_idx" ON "Changelog" ("type");
CREATE INDEX "Changelog_tags_idx" ON "Changelog" ("tags");
CREATE INDEX "Changelog_disabled_idx" ON "Changelog" ("disabled");

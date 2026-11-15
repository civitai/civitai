-- The minimal schema the feed-go integration tests (`-tags integration`) run against: exactly the
-- tables, columns and types feed-go's SQL reads (internal/feed/*.go, internal/hydrate/*.go), with the
-- main app's column types (packages/civitai-db-schema/prisma/schema.full.prisma). Not a copy of the
-- app's schema: a column feed-go does not read is left out, so a query that starts reading one fails
-- here until it is added.
--
-- Applied once per CI run by .github/workflows/feed-go.yml, before the integration tests.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TYPE "ImageGenerationProcess" AS ENUM ('txt2img', 'txt2imgHiRes', 'img2img', 'inpainting');
CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
CREATE TYPE "CosmeticType" AS ENUM ('Badge', 'NamePlate', 'ContentDecoration', 'ProfileDecoration', 'ProfileBackground', 'Sticker');
CREATE TYPE "CosmeticSource" AS ENUM ('Trophy', 'Purchase', 'Event', 'Membership', 'Claim');
CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
CREATE TYPE "ReviewReactions" AS ENUM ('Like', 'Dislike', 'Laugh', 'Cry', 'Heart');
CREATE TYPE "Model3DStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'Deleted');

CREATE TABLE "User" (
  id                 integer PRIMARY KEY,
  username           citext UNIQUE,
  image              text,
  "deletedAt"        timestamp(3),
  "profilePictureId" integer UNIQUE
);

CREATE TABLE "Post" (
  id               integer PRIMARY KEY,
  title            text,
  "userId"         integer NOT NULL,
  "modelVersionId" integer,
  "model3dId"      integer,
  "publishedAt"    timestamp(3),
  metadata         jsonb,
  availability     "Availability" NOT NULL DEFAULT 'Public'
);

CREATE TABLE "Image" (
  id                  integer PRIMARY KEY,
  name                text,
  url                 text NOT NULL,
  "userId"            integer NOT NULL,
  "createdAt"         timestamp(3) NOT NULL DEFAULT now(),
  meta                jsonb,
  hash                text,
  height              integer,
  width               integer,
  type                "MediaType" NOT NULL DEFAULT 'image',
  metadata            jsonb NOT NULL DEFAULT '{}',
  "nsfwLevel"         integer NOT NULL DEFAULT 0,
  "nsfwLevelLocked"   boolean NOT NULL DEFAULT false,
  "generationProcess" "ImageGenerationProcess",
  "postId"            integer,
  "needsReview"       text,
  "hideMeta"          boolean NOT NULL DEFAULT false,
  index               integer,
  "scannedAt"         timestamp(3),
  "mimeType"          text,
  ingestion           "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
  "blockedFor"        text,
  "scanJobs"          jsonb,
  minor               boolean NOT NULL DEFAULT false,
  poi                 boolean NOT NULL DEFAULT false,
  "acceptableMinor"   boolean NOT NULL DEFAULT false,
  "modelRestricted"   boolean NOT NULL DEFAULT false
);

CREATE TABLE "ImageResourceNew" (
  "imageId"        integer NOT NULL,
  "modelVersionId" integer NOT NULL,
  detected         boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("imageId", "modelVersionId")
);

CREATE TABLE "TagsOnImageDetails" (
  "imageId"     integer NOT NULL,
  "tagId"       integer NOT NULL,
  disabled      boolean NOT NULL,
  PRIMARY KEY ("imageId", "tagId")
);

CREATE TABLE "ImageReaction" (
  id        integer PRIMARY KEY,
  "imageId" integer NOT NULL,
  "userId"  integer NOT NULL,
  reaction  "ReviewReactions" NOT NULL
);

CREATE TABLE "Cosmetic" (
  id     integer PRIMARY KEY,
  name   text NOT NULL,
  type   "CosmeticType" NOT NULL,
  source "CosmeticSource" NOT NULL,
  data   jsonb NOT NULL,
  flags  integer NOT NULL DEFAULT 0
);

CREATE TABLE "Model" (
  id                integer PRIMARY KEY,
  "userId"          integer NOT NULL,
  mode              "ModelModifier",
  minor             boolean NOT NULL DEFAULT false,
  "sfwOnly"         boolean NOT NULL DEFAULT false,
  "gallerySettings" jsonb NOT NULL DEFAULT '{"users": [], "tags": [], "images": []}'
);

CREATE TABLE "ModelVersion" (
  id        integer PRIMARY KEY,
  "modelId" integer NOT NULL
);

CREATE TABLE "Model3D" (
  id          integer PRIMARY KEY,
  "userId"    integer NOT NULL,
  status      "Model3DStatus" NOT NULL DEFAULT 'Draft',
  "deletedAt" timestamp(3)
);

CREATE TABLE "ResourceReview" (
  id               integer PRIMARY KEY,
  "modelId"        integer NOT NULL,
  "modelVersionId" integer NOT NULL,
  rating           integer NOT NULL,
  recommended      boolean NOT NULL DEFAULT true,
  details          text,
  "userId"         integer NOT NULL,
  "postId"         integer
);

CREATE TABLE "Placement" (
  id           integer PRIMARY KEY,
  surface      text NOT NULL,
  "targetType" text NOT NULL,
  "targetId"   integer NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL,
  "resolvedAt" timestamp(3)
);

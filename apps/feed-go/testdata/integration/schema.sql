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
CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
CREATE TYPE "ModelType" AS ENUM ('Checkpoint', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'LORA', 'LoCon', 'DoRA',
  'Controlnet', 'Upscaler', 'MotionModule', 'VAE', 'TextEncoder', 'UNet', 'CLIPVision', 'Poses', 'Wildcards', 'Workflows',
  'ComfyWorkflows', 'Detection', 'VisionLanguage', 'CLIP', 'LLM', 'Other');
CREATE TYPE "CheckpointType" AS ENUM ('Trained', 'Merge');
CREATE TYPE "CommercialUse" AS ENUM ('None', 'Image', 'RentCivit', 'Rent', 'Sell', 'SellMerge');
CREATE TYPE "TrainingStatus" AS ENUM ('Pending', 'Submitted', 'Paused', 'Denied', 'Processing', 'InReview', 'Failed', 'Approved', 'Expired');
CREATE TYPE "PaidAccessEntityType" AS ENUM ('ModelVersion', 'ComicChapter');
CREATE TYPE "SaleDiscountType" AS ENUM ('Fixed', 'Percent');
CREATE TYPE "CosmeticEntity" AS ENUM ('Model', 'Image', 'Article', 'Post', 'Model3D');
CREATE TYPE "CosmeticShopItemStatus" AS ENUM ('Draft', 'PendingReview', 'Published', 'Rejected', 'RequestedChanges', 'Archived');
CREATE TYPE "ModelHashType" AS ENUM ('AutoV1', 'AutoV2', 'AutoV3', 'SHA256', 'CRC32', 'BLAKE3');
CREATE TYPE "TagType" AS ENUM ('UserGenerated', 'Label', 'Moderation', 'System');
CREATE TYPE "TagSource" AS ENUM ('User', 'Rekognition', 'WD14', 'Computed', 'ImageHash', 'Hive', 'MinorDetection',
  'HiveDemographics', 'Clavata', 'SpineRating', 'AiRecognition', 'AnimeRecognition');

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
  availability     "Availability" NOT NULL DEFAULT 'Public',
  -- source: image.getInfinite's pending view (pendingViewerSQL, internal/feed/query.go).
  "collectionId"   integer
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
  "modelRestricted"   boolean NOT NULL DEFAULT false,
  "tosViolation"      boolean NOT NULL DEFAULT false
);

CREATE TABLE "ImageResourceNew" (
  "imageId"        integer NOT NULL,
  "modelVersionId" integer NOT NULL,
  detected         boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("imageId", "modelVersionId")
);

-- source: the tag-ids miss lookup (internal/hydrate/misses.go). A view in the app with no default;
-- the default here only spares the feed tests' inserts from naming it.
CREATE TABLE "TagsOnImageDetails" (
  "imageId"     integer NOT NULL,
  "tagId"       integer NOT NULL,
  disabled      boolean NOT NULL,
  source        "TagSource" NOT NULL DEFAULT 'User',
  PRIMARY KEY ("imageId", "tagId")
);

-- source: getAllImages' `tools` filter (internal/feed/query.go). The app's notes and createdAt are
-- not read.
CREATE TABLE "ImageTool" (
  "imageId" integer NOT NULL,
  "toolId"  integer NOT NULL,
  PRIMARY KEY ("imageId", "toolId")
);

CREATE TABLE "ImageReaction" (
  id        integer PRIMARY KEY,
  "imageId" integer NOT NULL,
  "userId"  integer NOT NULL,
  reaction  "ReviewReactions" NOT NULL
);

CREATE TABLE "Cosmetic" (
  id            integer PRIMARY KEY,
  name          text NOT NULL,
  type          "CosmeticType" NOT NULL,
  source        "CosmeticSource" NOT NULL,
  data          jsonb NOT NULL,
  flags         integer NOT NULL DEFAULT 0,
  "createdById" integer
);

-- The cache miss lookups (internal/hydrate/misses.go): equipped and placed cosmetics, and the creator
-- shop listings getWithheldCosmeticIds reads.
CREATE TABLE "UserCosmetic" (
  "userId"         integer NOT NULL,
  "cosmeticId"     integer NOT NULL,
  "equippedAt"     timestamp(3),
  data             jsonb,
  "claimKey"       text NOT NULL DEFAULT 'claimed',
  "equippedToId"   integer,
  "equippedToType" "CosmeticEntity",
  PRIMARY KEY ("userId", "cosmeticId", "claimKey")
);

CREATE TABLE "CosmeticShopItem" (
  id                serial PRIMARY KEY,
  "cosmeticId"      integer,
  "addedById"       integer,
  meta              jsonb NOT NULL DEFAULT '{}',
  status            "CosmeticShopItemStatus" NOT NULL DEFAULT 'Published',
  "rejectionReason" text
);

-- The columns after "gallerySettings" (and on ModelVersion after "modelId") are model.getAll's
-- (internal/modelfeed); their defaults are the app's, so the image tests' inserts need not name them.
CREATE TABLE "Model" (
  id                integer PRIMARY KEY,
  "userId"          integer NOT NULL,
  mode              "ModelModifier",
  minor             boolean NOT NULL DEFAULT false,
  "sfwOnly"         boolean NOT NULL DEFAULT false,
  "gallerySettings" jsonb NOT NULL DEFAULT '{"users": [], "tags": [], "images": []}',
  name                    citext NOT NULL DEFAULT 'model',
  "sfwName"               citext,
  "coverImageId"          integer,
  "sfwCoverImageId"       integer,
  type                    "ModelType" NOT NULL DEFAULT 'Checkpoint',
  poi                     boolean NOT NULL DEFAULT false,
  nsfw                    boolean NOT NULL DEFAULT false,
  "nsfwLevel"             integer NOT NULL DEFAULT 0,
  status                  "ModelStatus" NOT NULL DEFAULT 'Draft',
  "createdAt"             timestamp(3) NOT NULL DEFAULT now(),
  "publishedAt"           timestamp(3),
  locked                  boolean NOT NULL DEFAULT false,
  meta                    jsonb NOT NULL DEFAULT '{}',
  availability            "Availability" NOT NULL DEFAULT 'Public',
  "checkpointType"        "CheckpointType",
  "allowNoCredit"         boolean NOT NULL DEFAULT true,
  "allowCommercialUse"    "CommercialUse"[] NOT NULL DEFAULT '{Image,RentCivit,Rent,Sell,SellMerge}',
  "allowDerivatives"      boolean NOT NULL DEFAULT true,
  "allowDifferentLicense" boolean NOT NULL DEFAULT true,
  "isOfficial"            boolean NOT NULL DEFAULT false
);

-- The columns after "trainingStatus" are dataForModelsCache's lookup's (internal/hydrate/modeldata.go).
CREATE TABLE "ModelVersion" (
  id               integer PRIMARY KEY,
  "modelId"        integer NOT NULL,
  "baseModel"      text NOT NULL DEFAULT 'SD 1.5',
  status           "ModelStatus" NOT NULL DEFAULT 'Draft',
  "trainingStatus" "TrainingStatus",
  index                  integer,
  name                   text NOT NULL DEFAULT 'version',
  "earlyAccessTimeFrame" integer NOT NULL DEFAULT 0,
  "baseModelType"        text NOT NULL DEFAULT 'Standard',
  "createdAt"            timestamp(3) NOT NULL DEFAULT now(),
  "publishedAt"          timestamp(3),
  flags                  integer NOT NULL DEFAULT 0,
  availability           "Availability" NOT NULL DEFAULT 'Public',
  "nsfwLevel"            integer NOT NULL DEFAULT 0,
  description            text,
  "trainedWords"         text[]
);

-- dataForModelsCache's lookup: the hashes (a view in the app's database), generation coverage and
-- the linked-VAE recommendations.
CREATE TABLE "ModelHash" (
  "modelId"        integer NOT NULL,
  "modelVersionId" integer NOT NULL,
  "hashType"       "ModelHashType" NOT NULL,
  "fileType"       text NOT NULL,
  hash             text NOT NULL
);

CREATE TABLE "GenerationCoverage" (
  "modelId"        integer NOT NULL,
  "modelVersionId" integer NOT NULL UNIQUE,
  covered          boolean NOT NULL,
  "coveredNext"    boolean NOT NULL,
  PRIMARY KEY ("modelId", "modelVersionId")
);

CREATE TABLE "RecommendedResource" (
  id           serial PRIMARY KEY,
  "resourceId" integer NOT NULL,
  "sourceId"   integer,
  settings     jsonb
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

-- model.getAll (internal/modelfeed).
CREATE TABLE "ModelMetric" (
  "modelId"           integer PRIMARY KEY,
  "downloadCount"     integer NOT NULL DEFAULT 0,
  "commentCount"      integer NOT NULL DEFAULT 0,
  "collectedCount"    integer NOT NULL DEFAULT 0,
  "imageCount"        integer NOT NULL DEFAULT 0,
  "tippedAmountCount" integer NOT NULL DEFAULT 0,
  "thumbsUpCount"     integer NOT NULL DEFAULT 0,
  "thumbsDownCount"   integer NOT NULL DEFAULT 0,
  poi                 boolean NOT NULL DEFAULT false,
  minor               boolean NOT NULL DEFAULT false,
  "nsfwLevel"         integer NOT NULL DEFAULT 0,
  "userId"            integer NOT NULL DEFAULT 0,
  "lastVersionAt"     timestamp(3),
  mode                "ModelModifier",
  status              "ModelStatus" NOT NULL DEFAULT 'Draft',
  availability        "Availability" NOT NULL DEFAULT 'Public',
  "hotScore"          integer
);

CREATE TABLE "ModelBaseModelMetric" (
  "modelId"       integer NOT NULL,
  "baseModel"     text NOT NULL,
  "thumbsUpCount" integer NOT NULL DEFAULT 0,
  "downloadCount" integer NOT NULL DEFAULT 0,
  "imageCount"    integer NOT NULL DEFAULT 0,
  status          "ModelStatus" NOT NULL DEFAULT 'Draft',
  availability    "Availability" NOT NULL DEFAULT 'Public',
  "nsfwLevel"     integer NOT NULL DEFAULT 0,
  mode            "ModelModifier",
  poi             boolean NOT NULL DEFAULT false,
  minor           boolean NOT NULL DEFAULT false,
  "hotScore"      integer,
  PRIMARY KEY ("modelId", "baseModel")
);

-- type: the tag-ids miss lookup's tag records (the app's default).
CREATE TABLE "Tag" (
  id   integer PRIMARY KEY,
  name citext NOT NULL UNIQUE,
  type "TagType" NOT NULL DEFAULT 'UserGenerated'
);

CREATE TABLE "TagsOnModels" (
  "modelId" integer NOT NULL,
  "tagId"   integer NOT NULL,
  PRIMARY KEY ("modelId", "tagId")
);

CREATE TABLE "PaidAccess" (
  "entityType"    "PaidAccessEntityType" NOT NULL,
  "entityId"      integer NOT NULL,
  "ownerId"       integer NOT NULL,
  "endsAt"        timestamp(3),
  "timeframeDays" integer,
  terms           jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("entityType", "entityId")
);

CREATE TABLE "ModelFile" (
  id               integer PRIMARY KEY,
  type             text NOT NULL DEFAULT 'Model',
  "modelVersionId" integer NOT NULL,
  metadata         jsonb
);

CREATE TABLE "ModelVersionSale" (
  id               integer PRIMARY KEY,
  "userId"         integer NOT NULL,
  "discountType"   "SaleDiscountType" NOT NULL DEFAULT 'Percent',
  "discountAmount" integer NOT NULL DEFAULT 10,
  "startsAt"       timestamp(3) NOT NULL,
  "endsAt"         timestamp(3) NOT NULL,
  "canceledAt"     timestamp(3)
);

CREATE TABLE "ModelVersionSaleItem" (
  "saleId"         integer NOT NULL,
  "modelVersionId" integer NOT NULL,
  PRIMARY KEY ("saleId", "modelVersionId")
);

-- model.getAll's collection filter: the permission read (internal/modelfeed/collection.go) and the
-- CollectionItem semi-join of the page query. CollectionContributor is also image.getInfinite's
-- pending view of a signed-in viewer (pendingViewerSQL, internal/feed/query.go).
CREATE TYPE "CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');

CREATE TABLE "Collection" (
  id       integer PRIMARY KEY,
  "userId" integer NOT NULL,
  read     "CollectionReadConfiguration" NOT NULL DEFAULT 'Private'
);

CREATE TABLE "CollectionItem" (
  id             integer PRIMARY KEY,
  "collectionId" integer NOT NULL,
  "modelId"      integer,
  -- image.getInfinite's collection page (the `ct` CTE, collectionCTE in internal/feed/query.go).
  "imageId"      integer,
  note           text,
  "addedById"    integer,
  status         "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED',
  "tagId"        integer
);

CREATE TABLE "CollectionContributor" (
  "userId"       integer NOT NULL,
  "collectionId" integer NOT NULL,
  permissions    "CollectionContributorPermission"[] NOT NULL,
  PRIMARY KEY ("userId", "collectionId")
);

-- model.getAll's community-cover guard (communityCoverGuard, internal/modelfeed/serve.go): the
-- featured rows getShowcaseCommunityCovers starts from. source is TEXT with a CHECK in the app.
CREATE TABLE "ModelVersionShowcaseItem" (
  "modelVersionId" integer NOT NULL,
  "imageId"        integer NOT NULL,
  source           text NOT NULL,
  removed          boolean NOT NULL DEFAULT false
);

# Outbox Tables

These are the tables that trigger events into the Outbox table for processing.

**Outbox Table Definition**
```sql
CREATE TYPE "OutboxEvent" AS ENUM (
  'PUBLISHED',
  'UNPUBLISHED',
  'DELETED',
  'UPDATED'
);

CREATE TYPE "OutboxEntity" AS ENUM (
  'Article',
  'Image',
  'Model',
  'Post'
);

CREATE TABLE "Outbox" (
    id BIGSERIAL PRIMARY KEY,
    event "OutboxEvent" NOT NULL,
    "entityType" "OutboxEntity" NOT NULL,
    "entityId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) default CURRENT_TIMESTAMP
);
```

## Image

## Model
**Triggers**
- DELETED:
  - UPDATE When DeletedAt is set
  - DELETE when deleted...
- PUBLISHED: UPDATE When PublishedAt is set from null
- UNPUBLISHED: UPDATE When PublishedAt is set to null from not null

```sql
CREATE TABLE PUBLIC."Model" (
NAME citext NOT NULL
,description TEXT
,type "ModelType" NOT NULL
,"createdAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
,"updatedAt" TIMESTAMP (3) NOT NULL
,nsfw boolean DEFAULT false NOT NULL
,id serial PRIMARY KEY
,"userId" INT NOT NULL REFERENCES PUBLIC."User" ON UPDATE CASCADE ON DELETE RESTRICT
,"tosViolation" boolean DEFAULT false NOT NULL
,STATUS "ModelStatus" DEFAULT 'Draft'::"ModelStatus" NOT NULL
,"fromImportId" INT REFERENCES PUBLIC."Import" ON UPDATE CASCADE ON DELETE SET NULL
,poi boolean DEFAULT false NOT NULL
,"publishedAt" TIMESTAMP (3)
,"lastVersionAt" TIMESTAMP (3)
,meta jsonb DEFAULT '{}'::jsonb NOT NULL
,"allowDerivatives" boolean DEFAULT true NOT NULL
,"allowDifferentLicense" boolean DEFAULT true NOT NULL
,"allowNoCredit" boolean DEFAULT true NOT NULL
,"deletedAt" TIMESTAMP (3)
,"checkpointType" "CheckpointType"
,locked boolean DEFAULT false NOT NULL
,"deletedBy" INT REFERENCES PUBLIC."User" ON UPDATE CASCADE ON DELETE SET NULL
,"underAttack" boolean DEFAULT false NOT NULL
,"earlyAccessDeadline" TIMESTAMP (3)
,mode "ModelModifier"
,"uploadType" "ModelUploadType" DEFAULT 'Created'::"ModelUploadType" NOT NULL
,unlisted boolean DEFAULT false NOT NULL
,"gallerySettings" jsonb DEFAULT '{"tags": [], "users": [], "images": []}'::jsonb NOT NULL
,availability "Availability" DEFAULT 'Public'::"Availability" NOT NULL
,"allowCommercialUse" "CommercialUse" [] DEFAULT ARRAY ['Image'::"CommercialUse", 'RentCivit'::"CommercialUse", 'Rent'::"CommercialUse", 'Sell'::"CommercialUse"] NOT NULL
,"nsfwLevel" INT DEFAULT 0 NOT NULL
,"lockedProperties" TEXT [] DEFAULT ARRAY []::TEXT []
,minor boolean DEFAULT false NOT NULL
,"scannedAt" TIMESTAMP (3)
,"sfwOnly" boolean DEFAULT false NOT NULL
);
```

## ModelVersion
**Triggers**
- PUBLISHED: UPDATE When PublishedAt is set from null
- UNPUBLISHED: UPDATE When PublishedAt is set to null from not null

```sql
CREATE TABLE PUBLIC."ModelVersion" (
NAME TEXT NOT NULL
,description TEXT
,steps INT
,epochs INT
,"createdAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
,"updatedAt" TIMESTAMP (3) NOT NULL
,id serial PRIMARY KEY
,"modelId" INT NOT NULL REFERENCES PUBLIC."Model" ON UPDATE CASCADE ON DELETE CASCADE
,"trainedWords" TEXT []
,STATUS "ModelStatus" DEFAULT 'Draft'::"ModelStatus" NOT NULL
,"fromImportId" INT REFERENCES PUBLIC."Import" ON UPDATE CASCADE ON DELETE SET NULL
,INDEX INT
,inaccurate boolean DEFAULT false NOT NULL
,"baseModel" TEXT NOT NULL
,meta jsonb DEFAULT '{}'::jsonb NOT NULL
,"earlyAccessTimeFrame" INT DEFAULT 0 NOT NULL
,"publishedAt" TIMESTAMP (3)
,"clipSkip" INT
,"vaeId" INT REFERENCES PUBLIC."ModelVersion" ON UPDATE CASCADE ON DELETE SET NULL
,"baseModelType" TEXT DEFAULT 'Standard'::TEXT NOT NULL
,"trainingDetails" jsonb
,"trainingStatus" "TrainingStatus"
,"requireAuth" boolean DEFAULT false NOT NULL
,settings jsonb
,availability "Availability" DEFAULT 'Public'::"Availability" NOT NULL
,"nsfwLevel" INT DEFAULT 0 NOT NULL
,"earlyAccessConfig" jsonb
,"earlyAccessEndsAt" TIMESTAMP (3)
,"uploadType" "ModelUploadType" DEFAULT 'Created'::"ModelUploadType" NOT NULL
,"usageControl" "ModelUsageControl" DEFAULT 'Download'::"ModelUsageControl" NOT NULL
);
```

## Post
**Triggers**
- PUBLISHED: UPDATE When PublishedAt is set from null
- UNPUBLISHED: UPDATE When PublishedAt is set to null from not null
- DELETED: DELETE when deleted
```sql
CREATE TABLE PUBLIC."Post" (
id serial PRIMARY KEY
,nsfw boolean DEFAULT false NOT NULL
,title TEXT
,detail TEXT
,"userId" INT NOT NULL REFERENCES PUBLIC."User" ON UPDATE CASCADE ON DELETE CASCADE
,"modelVersionId" INT REFERENCES PUBLIC."ModelVersion" ON UPDATE CASCADE ON DELETE SET NULL
,"createdAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
,"updatedAt" TIMESTAMP (3) NOT NULL
,"publishedAt" TIMESTAMP (3)
,metadata jsonb
,"tosViolation" boolean DEFAULT false NOT NULL
,"collectionId" INT REFERENCES PUBLIC."Collection" ON UPDATE CASCADE ON DELETE CASCADE
,availability "Availability" DEFAULT 'Public'::"Availability" NOT NULL
,unlisted boolean DEFAULT false NOT NULL
,"nsfwLevel" INT DEFAULT 0 NOT NULL
);
```

## Image
**Triggers**
- COVER_CHANGE: UPDATE index is set to 1 from something else and postId is not null (entityId should be postId)
- TO_SCAN: INSERT when ingestionStatus='Pending' OR UPDATE when ingestionStatus changes to 'Rescan' from any other status
```sql
CREATE TABLE PUBLIC."Image" (
NAME TEXT
,url TEXT NOT NULL
,"createdAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
,"updatedAt" TIMESTAMP (3) NOT NULL
,HASH TEXT
,id serial PRIMARY KEY
,"userId" INT NOT NULL REFERENCES PUBLIC."User" ON UPDATE CASCADE ON DELETE CASCADE
,height INT
,width INT
,meta jsonb
,"tosViolation" boolean DEFAULT false NOT NULL
,analysis jsonb
,"generationProcess" "ImageGenerationProcess"
,"featuredAt" TIMESTAMP (3)
,"hideMeta" boolean DEFAULT false NOT NULL
,INDEX INT
,"mimeType" TEXT
,"postId" INT REFERENCES PUBLIC."Post" ON UPDATE CASCADE ON DELETE SET NULL
,"scanRequestedAt" TIMESTAMP (3)
,"scannedAt" TIMESTAMP (3)
,"sizeKB" INT
,nsfw "NsfwLevel" DEFAULT 'None'::"NsfwLevel" NOT NULL
,"blockedFor" TEXT
,ingestion "ImageIngestionStatus" DEFAULT 'Pending'::"ImageIngestionStatus" NOT NULL
,"needsReview" TEXT
,metadata jsonb DEFAULT '{}'::jsonb NOT NULL
,type "MediaType" DEFAULT 'image'::"MediaType" NOT NULL
,"scanJobs" jsonb
,"nsfwLevel" INT DEFAULT 0 NOT NULL
,"nsfwLevelLocked" boolean DEFAULT false NOT NULL
,"aiNsfwLevel" INT DEFAULT 0 NOT NULL
,"aiModel" TEXT
,"sortAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
,"pHash" BIGINT
,minor boolean DEFAULT false NOT NULL
,poi boolean DEFAULT false NOT NULL
,"acceptableMinor" boolean DEFAULT false NOT NULL
);
```

## Articles
- PUBLISHED/UNPUBLISHED, status set to 'Published' or not
- DELETED, DELETE deleted
```sql
CREATE TABLE PUBLIC."Article" (
id serial PRIMARY KEY
,"createdAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP
,"updatedAt" TIMESTAMP (3)
,nsfw boolean DEFAULT false NOT NULL
,"tosViolation" boolean DEFAULT false NOT NULL
,metadata jsonb
,title TEXT NOT NULL
,content TEXT NOT NULL
,cover TEXT
,"publishedAt" TIMESTAMP (3)
,"userId" INT NOT NULL REFERENCES PUBLIC."User" ON UPDATE CASCADE ON DELETE CASCADE
,availability "Availability" DEFAULT 'Public'::"Availability" NOT NULL
,unlisted boolean DEFAULT false NOT NULL
,"coverId" INT
,"nsfwLevel" INT DEFAULT 0 NOT NULL
,"userNsfwLevel" INT DEFAULT 0 NOT NULL
,"lockedProperties" TEXT [] DEFAULT ARRAY []::TEXT []
,STATUS "ArticleStatus" DEFAULT 'Draft'::"ArticleStatus" NOT NULL
);
```

## Bounties
```sql
CREATE TABLE PUBLIC."Bounty" (
id serial PRIMARY KEY
,"userId" INT REFERENCES PUBLIC."User" ON UPDATE CASCADE ON DELETE SET NULL
,NAME TEXT NOT NULL
,description TEXT NOT NULL
,"startsAt" DATE NOT NULL
,"expiresAt" DATE NOT NULL
,"createdAt" TIMESTAMP (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
,"updatedAt" TIMESTAMP (3) NOT NULL
,details jsonb
,mode "BountyMode" DEFAULT 'Individual'::"BountyMode" NOT NULL
,"entryMode" "BountyEntryMode" DEFAULT 'Open'::"BountyEntryMode" NOT NULL
,type "BountyType" NOT NULL
,"minBenefactorUnitAmount" INT NOT NULL
,"maxBenefactorUnitAmount" INT
,"entryLimit" INT DEFAULT 1 NOT NULL
,nsfw boolean DEFAULT false NOT NULL
,complete boolean DEFAULT false NOT NULL
,poi boolean DEFAULT false NOT NULL
,refunded boolean DEFAULT false NOT NULL
,availability "Availability" DEFAULT 'Public'::"Availability" NOT NULL
,"nsfwLevel" INT DEFAULT 0 NOT NULL
,"lockedProperties" TEXT [] DEFAULT ARRAY []::TEXT []
);
```




## Request
1. create a sql file in `scripts/sql/outbox-triggers.sql`
2. For each set of tables and triggers, create an accurate and succinct TRIGGER definition that will write a corresponding event to the Outbox
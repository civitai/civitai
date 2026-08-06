# Front Page Audit.json

queries: 16   components: 19
resources: Replicated_Read_Prod, Prod, retool_db, JavascriptQuery

## component types (layout is NOT ported — this is only a scale signal)
  Function: 8
  State: 4
  Frame: 1
  CustomComponentWidget: 1
  ModalWidget: 1
  RadioGroupWidget2: 1
  TextAreaWidget: 1
  ButtonWidget2: 1
  JSONEditorWidget: 1

## queries

### ByNewestTest1235   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: Timestamp.data[0].lastCheckedAt, customComponent1.model.selectedAgeRating
    SELECT
      i.id,
    concat('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/',i.url,'/original=true/',REPLACE(i."name", '%', '')) url,
        (SELECT jsonb_agg(t.id) FROM "TagsOnImageDetails" toi JOIN "Tag" t ON toi."tagId" = t.id WHERE toi."imageId" = i.id AND NOT toi.disabled AND t.type = 'Moderation') "moderatedTags",
      false as selected,
      i."createdAt",
      i."meta" ->> 'prompt' AS "Prompt",
      i."needsReview",
      i."nsfwLevel" AS nsfwlevel,
      i."aiNsfwLevel" AS ainsfwlevel,
      i.poi
    FROM "Image" i
    WHERE i."createdAt" >  {{Timestamp.data[0].lastCheckedAt}}
      AND i."nsfwLevel" = {{customComponent1.model.selectedAgeRating}}
      AND i.ingestion = 'Scanned'
      AND i."nsfwLevelLocked" = false
      AND NOT i."ingestion" = 'Blocked'
      AND i.minor = false
      AND i.metadata ->> 'parentId' IS NULL
      AND i."needsReview" IS NULL
      AND i.type = 'video'
    ORDER BY i."createdAt" ASC
    LIMIT 20

### OLDByNewest   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: Timestamp.data.lastCheckedAt, AgeTransformer.value
    SELECT
      i.id,
    concat('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/',i.url,'/width=400/',i.name) url,
        (SELECT jsonb_agg(t.id) FROM "TagsOnImage" toi JOIN "Tag" t ON toi."tagId" = t.id WHERE toi."imageId" = i.id AND NOT toi.disabled AND t.type = 'Moderation') "moderatedTags",
      false as selected,
      i."createdAt",
      "meta" ->> 'prompt' AS "Prompt",
      i."needsReview",
      i."nsfwLevel" AS nsfwlevel
    FROM "Image" i
    WHERE i."createdAt" > {{Timestamp.data.lastCheckedAt}}
      AND i.nsfw = {{AgeTransformer.value}} -- 'None', 'Soft', 'Mature', 'X'
      AND i.ingestion = 'Scanned'
    ORDER BY i."createdAt" ASC
    LIMIT 200;

### ByReactions   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: AgeTransformer.value
    SELECT
      i.id,  concat('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/', i.url, '/width=450/', i.name, '.png') url,
      (SELECT jsonb_agg(t.id) FROM "TagsOnImage" toi JOIN "Tag" t ON toi."tagId" = t.id WHERE toi."imageId" = i.id AND NOT toi.disabled AND t.type = 'Moderation') "moderatedTags",
        false as selected,
        "meta" ->> 'prompt' AS "Prompt",
      i."needsReview"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ImageRank" ir ON ir."imageId" = i.id
    WHERE p."publishedAt" < now() AND p."publishedAt" IS NOT NULL
      AND i.nsfw = {{AgeTransformer.value}} -- 'None', 'Soft', 'Mature', 'X'
    ORDER BY ir."reactionCountWeekRank"
    LIMIT 100;

### TagVote   [SqlQueryUnified / Prod] 
    depends on: customComponent1.model.voteParams.imageId, customComponent1.model.voteParams.tagId, userIdVar.value, customComponent1.model.voteParams.vote
    INSERT INTO "TagsOnImageVote" ("imageId", "tagId", "userId", vote)
    VALUES ({{customComponent1.model.voteParams.imageId}}, {{customComponent1.model.voteParams.tagId}}, {{userIdVar.value}}, {{customComponent1.model.voteParams.vote}})
    ON CONFLICT ("imageId", "tagId", "userId") DO UPDATE SET "createdAt" = now(), vote = {{customComponent1.model.voteParams.vote}};

### LogNsfwLevel2   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: RatingChanges

### SetSelectedFilter   [JavascriptQuery / JavascriptQuery] 
    selectedFilter.setValue(customComponent1.model.selectedFilter);

### SetSelectedAge   [JavascriptQuery / JavascriptQuery] 
    selectedAge.setValue(customComponent1.model.selectedAgeRating);

### Timestamp   [SqlQueryUnified / retool_db] 
    depends on: selectedAge.value
    SELECT "lastCheckedAt", "username", "buttonPressedTime"
    FROM "FrontPageTimers"
    WHERE nsfw = {{selectedAge.value}}
    ORDER BY "lastCheckedAt" DESC
    LIMIT 1

### LogTimestamp   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: FrontPageTimers

### RunTheCorrectQuery   [JavascriptQuery / JavascriptQuery] 
    if(selectedFilter.value === "Newest"){
      ByNewestTest1235.trigger();
    } else {
      ByReactions.trigger();
    }

### OpenModal   [JavascriptQuery / JavascriptQuery] 
    modal1.open();

### UpdateNsfwLevel   [SqlQueryUnified / Prod] 
    depends on: customComponent1.model.labelParams.nsfwLevel, customComponent1.model.labelParams.imageId
    UPDATE "Image"
        SET 
          "nsfwLevel" = {{customComponent1.model.labelParams.nsfwLevel}},
          "nsfwLevelLocked" = TRUE
        WHERE id = {{customComponent1.model.labelParams.imageId}}

### LogNsfwLevel   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: RatingChanges

### InsertModActivity   [SqlQueryUnified / Prod] 
    depends on: current_user.metadata.userIdCivit, customComponent1.model.labelParams.imageId
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
        VALUES(
          {{current_user.metadata.userIdCivit}}, 
          'image', 
          'setNsfwLevel', 
          {{customComponent1.model.labelParams.imageId}})
        ON CONFLICT ("entityType", activity, "entityId") DO UPDATE SET "createdAt" = NOW(), "userId" = {{current_user.metadata.userIdCivit}}

### InsertRatingGame   [SqlQueryUnified / Prod] 
    depends on: current_user.metadata.userIdCivit, customComponent1.model.labelParams.imageId, customComponent1.model.labelParams.nsfwLevel
    INSERT INTO "research_ratings" ("userId", "imageId", "nsfwLevel")
    VALUES ({{current_user.metadata.userIdCivit}}, {{customComponent1.model.labelParams.imageId}}, {{customComponent1.model.labelParams.nsfwLevel}})
    ON CONFLICT ("userId", "imageId") DO UPDATE SET "nsfwLevel" = EXCLUDED."nsfwLevel"
    RETURNING "imageId";

### ByNewestTest1236   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: Timestamp.data[0].lastCheckedAt, customComponent1.model.selectedAgeRating
    SELECT
      i.id,
    concat('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/',i.url,'/width=450,quality=90/',i.name) url,
        (SELECT jsonb_agg(t.id) FROM "TagsOnImage" toi JOIN "Tag" t ON toi."tagId" = t.id WHERE toi."imageId" = i.id AND NOT toi.disabled AND t.type = 'Moderation') "moderatedTags",
      false as selected,
      i."createdAt",
      i."meta" ->> 'prompt' AS "Prompt",
      i."needsReview",
      i."nsfwLevel" AS nsfwlevel,
      i."aiNsfwLevel" AS ainsfwlevel,
      u."profilePictureId",
      ic."imageId" AS "isBounty"
    FROM "Image" i
    LEFT JOIN "User" u ON u."profilePictureId" = i."id"
    LEFT JOIN "ImageConnection" ic ON ic."imageId" = i."id"
    WHERE i."createdAt" >  {{Timestamp.data[0].lastCheckedAt}}
      AND i."nsfwLevel" = {{customComponent1.model.selectedAgeRating}}
      AND i.ingestion = 'Scanned'
      AND i."nsfwLevelLocked" = false
      AND NOT i."ingestion" = 'Blocked'
    ORDER BY i."createdAt" ASC
    LIMIT 200

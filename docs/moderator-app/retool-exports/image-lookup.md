# image-lookup.json

queries: 10   components: 21
resources: Replicated_Read_Prod, Clickhouse

## component types (layout is NOT ported — this is only a scale signal)
  TextWidget2: 7
  TableWidget2: 7
  TextInputWidget2: 2
  ContainerWidget2: 2
  Frame: 1
  ButtonWidget2: 1
  TabsWidget2: 1

## tabs & option sets — READ THESE, they are functionality
  Tab labels are the app's table of contents; dropdown options are canned workflows that
  exist in no query. A tab you did not port is a capability you did not port.

### tabbedContainer1   [ContainerWidget2]
    - ModActivity
    - Reactions
    - Tags
    - ShadowTags

### tabs1   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

## queries

### GetImageData   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: imageInput.value
    SELECT "blockedFor", "needsReview", * FROM "Image" WHERE "id" = {{imageInput.value}}

### Reactions   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: imageInput.value
    SELECT 
      ir."userId",
      ir."reaction",
      u."username",
      ir."createdAt",
      ir."updatedAt"
    FROM "ImageReaction" ir
    JOIN "User" u ON u."id" = ir."userId"
    WHERE ir."imageId" = {{imageInput.value}}

### ReactionsIP   [SqlQuery / Clickhouse] 
    depends on: imageInput.value
    SELECT 
      "userId",
      "ip",
      "reaction"
    FROM default.reactions
    WHERE entityId = {{imageInput.value}}

### Tags   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: imageInput.value
    SELECT 
      t.id,
      t."name",
      t."nsfwLevel",
      t."isCategory",
      toi."automated",
      toi."confidence",
      toi."disabled",
      toi."needsReview",
      toi."source"
    FROM "TagsOnImageDetails" toi
    JOIN "Tag" t ON t."id" = toi."tagId"
    WHERE toi."imageId" = {{imageInput.value}}

### ModActivity   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: imageInput.value
    SELECT * FROM "ModActivity" WHERE "entityId" = {{imageInput.value}}

### ImageTOs   [SqlQuery / Clickhouse] 
    depends on: imageInput.value
    SELECT * FROM "default"."images" where "imageId" = {{imageInput.value}}

### ReactionsIP2   [SqlQuery / Clickhouse] 
    depends on: imageInput.value
    SELECT 
      count(*),
      ip
    FROM default.reactions
    WHERE entityId = {{imageInput.value}}
    AND type = 'Image_Create'
    GROUP BY ip
    ORDER BY 1 desc

### query9   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: imageInput.value
    SELECT * 
    FROM "Report" r 
    JOIN "ImageReport" ir ON ir."reportId" = r.id
    WHERE ir."imageId" = {{imageInput.value}}

### ShadowTags   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: imageInput.value
    SELECT
      stoi.confidence,
      t.name,
      t.id
    FROM "ShadowTagsOnImage" stoi
    JOIN "Tag" t ON t.id = stoi."tagId"
    WHERE "imageId" = {{ imageInput.value }}

### GetIdFromUrl   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textInput1.value
    SELECT id FROM "Image" WHERE url = {{ textInput1.value }}

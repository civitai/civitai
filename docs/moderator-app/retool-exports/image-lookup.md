# image-lookup.json

queries: 10   components: 21
resources: Replicated_Read_Prod, Clickhouse

## component types (scale signal; the structure itself is below)
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

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

### container1   [ContainerWidget2] — 1 pane(s)
  - "View 1"  [9b145]
      c 0 w 2  imageInput [TextInputWidget2] "Image Id"
      c 2 w 2  button1 [ButtonWidget2] "Search"
      c 5 w 3  text3 [TextWidget2]
      c 0 w 3  textInput1 [TextInputWidget2] "Image URL"
      c 3 w 3  text6 [TextWidget2]
      c 0 w12  tabbedContainer1 [ContainerWidget2]
      c 0 w12  containerTitle1 [TextWidget2]   (not in a pane)

### tabbedContainer1   [ContainerWidget2] — 4 pane(s), tab bar tabs1  (inside container1)
  - "ModActivity"  [30533]
      c 0 w 6  text1 [TextWidget2]
      c 0 w 8  table3 [TableWidget2]
      c 0 w 6  text2 [TextWidget2]
      c 0 w 9  table4 [TableWidget2]
      c 0 w 6  text4 [TextWidget2]
      c 0 w 9  table5 [TableWidget2]
      c 0 w 3  text5 [TextWidget2]
      c 0 w 9  table6 [TableWidget2]
  - "Reactions"  [eadc7]
      c 0 w12  table1 [TableWidget2]
  - "Tags"  [3c65e]
      c 0 w12  table2 [TableWidget2]
  - "ShadowTags"  [a3e2c]
      c 0 w 9  table7 [TableWidget2]
      c 0 w12  tabs1 [TabsWidget2]   (not in a pane)

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

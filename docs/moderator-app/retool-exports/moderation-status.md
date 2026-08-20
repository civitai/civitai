# moderation-status.json

queries: 77   components: 197
resources: retool_db, Replicated_Read_Prod, REST-WithoutResource

## component types (scale signal; the structure itself is below)
  TextWidget2: 73
  ButtonWidget2: 51
  Function: 21
  DividerWidget: 18
  ContainerWidget2: 17
  TableWidget2: 6
  ListViewWidget2: 2
  PlotlyChartWidget: 2
  ModalFrameWidget: 2
  Frame: 1
  TabsWidget2: 1
  SelectWidget2: 1
  ImageWidget2: 1
  TextAreaWidget: 1

## tabs & option sets — READ THESE, they are functionality
  Tab labels are the app's table of contents; dropdown options are canned workflows that
  exist in no query. A tab you did not port is a capability you did not port.

### tabbedContainer1   [ContainerWidget2]
    - Moderation Status
    - Image Help
    - Graphs
    - Who is who?

### tabs1   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

### container1   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [b8068]
      c 4 w 4  button74 [ButtonWidget2] "Urgent Content ({{ UrgentReports.data.id.length }}"
      c 0 w 6  container2 [ContainerWidget2]
      c 6 w 6  container8 [ContainerWidget2]
      c 6 w 6  container3 [ContainerWidget2]
      c 0 w 6  container4 [ContainerWidget2]
      c 0 w 6  container10 [ContainerWidget2]
      c 0 w 8  text7 [TextWidget2]   (not in a pane)

### container2   [ContainerWidget2] — 1 pane(s)  (inside container1)
  - "View 1"  [b8068]
      c 4 w 3  button36 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 7 w 5  text68 [TextWidget2]
      c 0 w 3  text1 [TextWidget2]
      c 3 w 1  button39 [ButtonWidget2]
      c 0 w12  divider2 [DividerWidget]
      c 7 w 5  text69 [TextWidget2]
      c 0 w 3  text8 [TextWidget2]
      c 3 w 1  button40 [ButtonWidget2]
      c 4 w 3  button2 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 0 w12  divider4 [DividerWidget]
      c 4 w 3  button64 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 0 w 4  text88 [TextWidget2]
      c 7 w 5  text89 [TextWidget2]
      c 0 w12  divider21 [DividerWidget]
      c 0 w 4  text93 [TextWidget2]
      c 7 w 5  text94 [TextWidget2]
      c 4 w 3  button68 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 0 w12  divider19 [DividerWidget]
      c 3 w 1  button41 [ButtonWidget2]
      c 4 w 3  button3 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 0 w 3  text9 [TextWidget2]
      c 7 w 5  text90 [TextWidget2]
      c 0 w12  divider22 [DividerWidget]
      c 4 w 3  button4 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 0 w 3  text43 [TextWidget2]
      c 0 w12  divider5 [DividerWidget]
      c 0 w 3  text10 [TextWidget2]
      c 4 w 3  button59 [ButtonWidget2] "{{TagQueue.data.id.length > 100 ? '100+' : TagQueu"
      c 7 w 5  text52 [TextWidget2]
      c 0 w12  divider12 [DividerWidget]
      c 0 w12  group8 [ContainerWidget2]
      c 0 w12  group10 [ContainerWidget2]
      c 0 w12  group11 [ContainerWidget2]
      c 0 w12  group12 [ContainerWidget2]
      c 0 w12  containerTitle1 [TextWidget2]   (not in a pane)

### container3   [ContainerWidget2] — 1 pane(s)  (inside container1)
  - "View 1"  [b8068]
      c 0 w 5  text13 [TextWidget2]
      c 5 w 3  button7 [ButtonWidget2] "{{OLDReports.data.Model[0]}}"
      c 8 w 4  text53 [TextWidget2]
      c 8 w 4  text57 [TextWidget2]
      c 0 w 5  text14 [TextWidget2]
      c 5 w 3  button8 [ButtonWidget2] "{{OLDReports.data.Comment[0]}}"
      c 8 w 4  text55 [TextWidget2]
      c 8 w 4  text56 [TextWidget2]
      c 0 w 5  text15 [TextWidget2]
      c 5 w 3  button9 [ButtonWidget2] "{{OLDReports.data.CommentV2[0]}}"
      c 8 w 4  text58 [TextWidget2]
      c 5 w 3  button10 [ButtonWidget2] "{{OLDReports.data.ResourceReview[0]}}"
      c 0 w 5  text16 [TextWidget2]
      c 8 w 4  text59 [TextWidget2]
      c 8 w 4  text60 [TextWidget2]
      c 0 w 5  text17 [TextWidget2]
      c 5 w 3  button11 [ButtonWidget2] "{{OLDReports.data.Article[0]}}"
      c 8 w 4  text61 [TextWidget2]
      c 5 w 3  button12 [ButtonWidget2] "{{OLDReports.data.Post[0]}}"
      c 0 w 5  text18 [TextWidget2]
      c 0 w 5  text36 [TextWidget2]
      c 5 w 3  button21 [ButtonWidget2] "{{OLDReports.data.User[0]}}"
      c 8 w 4  text62 [TextWidget2]
      c 0 w 5  text37 [TextWidget2]
      c 5 w 3  button22 [ButtonWidget2] "{{OLDReports.data.Collection[0]}}"
      c 0 w 5  text38 [TextWidget2]
      c 5 w 3  button23 [ButtonWidget2] "{{OLDReports.data.Bounty[0]}}"
      c 0 w 5  text39 [TextWidget2]
      c 5 w 3  button24 [ButtonWidget2] "{{OLDReports.data.BountyEntry[0]}}"
      c 0 w 5  text44 [TextWidget2]
      c 5 w 3  button35 [ButtonWidget2] "{{OLDReports.data.Chat[0]}}"
      c 8 w 4  text63 [TextWidget2]
      c 8 w 4  text64 [TextWidget2]
      c 0 w12  divider1 [DividerWidget]
      c 0 w12  containerTitle2 [TextWidget2]   (not in a pane)

### container4   [ContainerWidget2] — 1 pane(s)  (inside container1)
  - "View 1"  [b8068]
      c 0 w12  group1 [ContainerWidget2]
      c 0 w 8  group9 [ContainerWidget2]
      c 0 w12  containerTitle3 [TextWidget2]   (not in a pane)

### tabbedContainer1   [ContainerWidget2] — 4 pane(s), tab bar tabs1
  - "Moderation Status"  [fac9d]
      c 0 w12  container1 [ContainerWidget2]
  - "Image Help"  [954d7]
      c 2 w 2  select1 [SelectWidget2] "Help Requests"
      c 5 w 2  text49 [TextWidget2]
      c 8 w 2  button42 [ButtonWidget2] "Aid has been supplied"
      c 5 w 2  text50 [TextWidget2]
      c 2 w 8  gridView1 [ListViewWidget2]
  - "Graphs"  [af576]
      c 0 w 2  button43 [ButtonWidget2] "Load Graphs"
      c 0 w 4  chart1 [PlotlyChartWidget] "Model Uploads"
      c 4 w 4  chart2 [PlotlyChartWidget] "Image Uploads"
      c 6 w 4  text79 [TextWidget2]
      c 0 w 3  text70 [TextWidget2]
      c 0 w 6  table1 [TableWidget2]
      c 6 w 6  table2 [TableWidget2]
  - "Who is who?"  [db300]
      c 0 w 4  textArea1 [TextAreaWidget] "Label"
      c 0 w12  tabs1 [TabsWidget2]   (not in a pane)

### container6   [ContainerWidget2] — 1 pane(s)  (inside gridView1)
  - "View 1"  [5ea16]
      c 0 w12  image1 [ImageWidget2]
      c 0 w12  text46 [TextWidget2]
      c 0 w12  text48 [TextWidget2]
      c 0 w12  containerTitle5 [TextWidget2]   (not in a pane)

### container7   [ContainerWidget2] — 1 pane(s)  (inside listView1)
  - "View 1"  [c7c92]
      c 0 w 3  text65 [TextWidget2]
      c 3 w 3  button44 [ButtonWidget2] "{{item.count}}"
      c 6 w 5  text66 [TextWidget2]
      c 0 w12  containerTitle6 [TextWidget2]   (not in a pane)

### container8   [ContainerWidget2] — 1 pane(s)  (inside container1)
  - "View 1"  [77aae]
      c 0 w12  listView1 [ListViewWidget2]
      c 0 w12  container9 [ContainerWidget2]
      c 0 w12  containerTitle7 [TextWidget2]   (not in a pane)

### group1   [ContainerWidget2] — 1 pane(s)  (inside container4)
  - "View 1"  [12d7c]
      c 2 w 1  button69 [ButtonWidget2] "Split"
      c 3 w 1  button38 [ButtonWidget2]
      c 4 w 3  button13 [ButtonWidget2] "{{ PGTime.value }} behind"
      c 7 w 5  text42 [TextWidget2]
      c 0 w 2  text19 [TextWidget2]
      c 0 w12  divider23 [DividerWidget]
      c 0 w 3  text71 [TextWidget2]
      c 3 w 1  button53 [ButtonWidget2]
      c 4 w 3  button45 [ButtonWidget2] "{{ PG13Time.value }} behind"
      c 7 w 5  text72 [TextWidget2]
      c 0 w12  divider13 [DividerWidget]
      c 0 w 4  text20 [TextWidget2]
      c 4 w 3  button15 [ButtonWidget2] "{{ArticleCount.data.count[0]}}"
      c 7 w 1  button32 [ButtonWidget2]
      c 0 w12  divider7 [DividerWidget]
      c 4 w 3  button16 [ButtonWidget2] "{{BountyCount.data.count[0]}}"
      c 7 w 1  button33 [ButtonWidget2]
      c 0 w 4  text21 [TextWidget2]
      c 0 w12  divider24 [DividerWidget]
      c 4 w 3  button78 [ButtonWidget2] "{{ Inquisitor1Queue.data.result }}"
      c 0 w 4  text96 [TextWidget2]

### group7   [ContainerWidget2] — 1 pane(s)  (inside container9)
  - "View 1"  [b8691]
      c 3 w 3  button30 [ButtonWidget2] "{{ModelReview.data.needsreview[0]}}"
      c 0 w 3  text41 [TextWidget2]

### container9   [ContainerWidget2] — 1 pane(s)  (inside container8)
  - "View 1"  [b8691]
      c 0 w11  group7 [ContainerWidget2]
      c 0 w12  containerTitle8 [TextWidget2]   (not in a pane)

### group8   [ContainerWidget2] — 1 pane(s)  (inside container2)
  - "View 1"  [7f57f]
      c 0 w 3  text80 [TextWidget2]
      c 4 w 3  button52 [ButtonWidget2] "{{RatingQueue.data.count[0]}}"
      c 7 w 5  text81 [TextWidget2]
      c 0 w12  divider25 [DividerWidget]

### group9   [ContainerWidget2] — 1 pane(s)  (inside container4)
  - "View 1"  [052a4]
      c 0 w 6  text82 [TextWidget2]
      c 6 w 4  button54 [ButtonWidget2] "{{ModelCount.data.count[0]}}"
      c11 w 1  button55 [ButtonWidget2]

### container10   [ContainerWidget2] — 1 pane(s)  (inside container1)
  - "View 1"  [b8068]
      c 0 w 4  text83 [TextWidget2]
      c 4 w 3  button56 [ButtonWidget2] "{{ BlockedImagesTask.data.count[0] }}"
      c 7 w 5  text84 [TextWidget2]
      c 0 w12  divider17 [DividerWidget]
      c 0 w 4  text85 [TextWidget2]
      c 4 w 3  button57 [ButtonWidget2] "{{ CivitModelsData.data.id.length }}"
      c 7 w 1  button58 [ButtonWidget2]
      c 0 w12  divider18 [DividerWidget]
      c 0 w 4  text87 [TextWidget2]
      c 4 w 3  button62 [ButtonWidget2] "{{ TrainingCount.data.count[0] }}"
      c 0 w 4  text95 [TextWidget2]
      c 4 w 3  button75 [ButtonWidget2] "{{formatDataAsArray(ReviewGrouped.data).find(i=>i."
      c 0 w12  table10 [TableWidget2]
      c 0 w12  containerTitle9 [TextWidget2]   (not in a pane)

### group10   [ContainerWidget2] — 1 pane(s)  (inside container2)
  - "View 1"  [7f57f]
      c 0 w 3  text100 [TextWidget2]
      c 4 w 3  button80 [ButtonWidget2] "{{ErrorRatingQueue.data.count[0]}}"
      c 0 w12  divider26 [DividerWidget]

### group11   [ContainerWidget2] — 1 pane(s)  (inside container2)
  - "View 1"  [7f57f]
      c 0 w 3  text101 [TextWidget2]
      c 4 w 3  button81 [ButtonWidget2] "{{ComicReview.data.count[0]}}"
      c 0 w12  divider27 [DividerWidget]

### group12   [ContainerWidget2] — 1 pane(s)  (inside container2)
  - "View 1"  [7f57f]
      c 0 w 4  text102 [TextWidget2]
      c 4 w 3  button82 [ButtonWidget2] "{{ArticleReview.data.count[0]}}"
      c 0 w12  divider28 [DividerWidget]

### gridView1   (1)
    c 0 w12  container6 [ContainerWidget2]

### listView1   (1)
    c 0 w12  container7 [ContainerWidget2]

## queries

### GetHelpers   [SqlQueryUnified / retool_db] 
    SELECT * FROM "ModerationImageHelp" WHERE "isHandled" = false

### GetImageData   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: select1.data.find(i => i.id === select1.value).imageIds.id
    -- (From lib/GetImageData.sql) Returns image metadata for selected help request; also includes a link to the image on the civitai domain.
    SELECT
      i."id" AS id,
      i."url" AS url, 
      concat('https://civitai.red/images/', i."id") AS link,
      "needsReview",
      "blockedFor",
      "ingestion"
    FROM "Image" i 
    WHERE i."id" = ANY({{select1.data.find(i => i.id === select1.value).imageIds.id}})

### GetMinors   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT "id"
    FROM "Image"
    WHERE "needsReview" = 'minor' 
    AND "ingestion" IS NOT NULL

### GetPoI   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT "id"
    FROM "Image" i 
    WHERE "needsReview" = 'poi' 
    AND "ingestion" IS NOT NULL

### GetReported   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      ir."imageId"
    FROM "ImageReport" ir
    JOIN "Report" r ON r.id = ir."reportId"
    WHERE r.status = 'Pending';

### StoreMinors   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ModerationImageHelp

### StorePoI   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ModerationImageHelp

### BountyTimer   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'bounties'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### ModelReview   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT("meta"->>'needsReview') AS needsReview FROM "Model"
    WHERE "meta"->>'needsReview' = 'true'
    AND "status" = 'UnpublishedViolation'

### TagQueue   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      COUNT(DISTINCT "imageId") AS "TagReviewQueue"
    FROM "TagsOnImageDetails" toi
    JOIN "Image" i ON toi."imageId" = i.id
    WHERE toi."needsReview"
    AND toi.disabled = false
    AND i."nsfwLevel" < 32

### RatingQueue   [SqlQueryUnified / Replicated_Read_Prod] 
    WITH image_rating_requests AS (
        SELECT
            "imageId",
            COALESCE(SUM(weight), 0) total,
            MIN("createdAt") AS "createdAt",
            jsonb_build_object(
                1, COALESCE(SUM(weight) FILTER (WHERE "nsfwLevel" = 1), 0),
                2, COALESCE(SUM(weight) FILTER (WHERE "nsfwLevel" = 2), 0),
                4, COALESCE(SUM(weight) FILTER (WHERE "nsfwLevel" = 4), 0),
                8, COALESCE(SUM(weight) FILTER (WHERE "nsfwLevel" = 8), 0),
                16, COALESCE(SUM(weight) FILTER (WHERE "nsfwLevel" = 16), 0)
            ) AS votes
        FROM "ImageRatingRequest"
        WHERE status = 'Pending'
        GROUP BY "imageId"
    )
    SELECT COUNT(*)
    FROM image_rating_requests irr
    JOIN "Image" i ON i.id = irr."imageId"
    WHERE (
        irr.total >= 3
        OR (irr.total <= -5 AND irr."createdAt" < NOW() - INTERVAL '10 hours')
    )
    AND i."nsfwLevelLocked" = FALSE
    AND i."nsfwLevel" != 32
    AND i."blockedFor" IS NULL

### HolidayPostsBulbs   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textInput1.value
    SELECT
      u.username,
      json_agg(json_build_array(p.id, date_part('epoch', p."publishedAt")*1000)) as earned,
      COUNT(DISTINCT date_trunc('day', p."publishedAt")) as posts,
      MAX(p."publishedAt") as last_published,
      MAX(p."id") as last_id,
      MAX(IIF(jsonb_typeof(uc.data->'lights') = 'number', CAST(uc.data->'lights' as int), 0)) as bulbs
    FROM "Post" p
    JOIN "UserCosmetic" uc ON uc."userId" = p."userId"
    JOIN "User" u ON u.id = uc."userId"
    JOIN "Cosmetic" c ON uc."cosmeticId" = c.id AND c.name LIKE 'Holiday Garland%'
    WHERE p."publishedAt" IS NOT NULL AND p."publishedAt" >= uc."obtainedAt" AND p."publishedAt" < now() AND u.username =
    {{textInput1.value}}
    GROUP BY u.username

### TagTimer   [SqlQueryUnified / retool_db] 
    WITH RankedFrontPageTimers AS (
        SELECT
            "lastCheckedAt",
            "username",
            "buttonPressedTime",
            "nsfw",
            ROW_NUMBER() OVER (PARTITION BY nsfw ORDER BY "lastCheckedAt" DESC) AS RowNum
        FROM
            "FrontPageTimers"
        WHERE
            nsfw IN ('1', '2', '4', '8', '16')
    )
    SELECT
        "lastCheckedAt",
        "username",
        "buttonPressedTime",
        "nsfw"
    FROM
        RankedFrontPageTimers
    WHERE
        RowNum = 1
    ORDER BY
        "lastCheckedAt" DESC
    LIMIT 5;

### FPATaskTimers   [SqlQueryUnified / retool_db] 
    WITH RankedFrontPageTimers AS (
        SELECT
            "task",
            "lastUpdate",
            "lastUpdateBy",
            ROW_NUMBER() OVER (PARTITION BY task ORDER BY "lastUpdate" DESC) AS RowNum
        FROM
            "Mods_TaskTimers"
        WHERE
            task IN ('1', '2', '4', '8', '16')
    )
    SELECT
        "task",
        "lastUpdate",
        "lastUpdateBy"
    FROM
        RankedFrontPageTimers
    WHERE
        RowNum = 1
    ORDER BY
        "lastUpdate" DESC
    LIMIT 5;

### ImageSfwData   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: formatDataAsArray(TagTimer.data).find(i=> i.nsfw == 1).lastCheckedAt
    SELECT
      "id",
      "nsfw",
      "ingestion",
      "nsfwLevel"
    FROM "Image"
    WHERE "createdAt" > {{ formatDataAsArray(TagTimer.data).find(i=> i.nsfw == 1).lastCheckedAt }}

### ImagePG13Data   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: formatDataAsArray(TagTimer.data).find(i=> i.nsfw == 2).lastCheckedAt
    SELECT
      "id",
      "nsfw",
      "ingestion",
      "nsfwLevel"
    FROM "Image"
    WHERE "createdAt" > {{ formatDataAsArray(TagTimer.data).find(i=> i.nsfw == 2).lastCheckedAt }}

### BountyCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: BountyTimer.data.lastUpdate[0]
    SELECT COUNT(*) FROM "Bounty" WHERE "createdAt" > {{BountyTimer.data.lastUpdate[0]}}

### BountyCheck   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### ArticleTimer   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'articles'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### ArticleCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: ArticleTimer.data.lastUpdate[0]
    SELECT COUNT(*) FROM "Article" WHERE "createdAt" > {{ArticleTimer.data.lastUpdate[0]}}

### ArticleCheck   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### MinorTimers   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'minor'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### StoreReported   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ModerationImageHelp

### HourlyImages   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), date_trunc('hour', "createdAt") AS hour_created
    FROM "Image"
    WHERE "createdAt" > NOW() - INTERVAL '200 hour'
    GROUP BY date_trunc('hour', "createdAt")
    ORDER BY hour_created DESC;

### UpdateHelpRequest   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ModerationImageHelp

### HourlyModels   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), date_trunc('hour', "createdAt") AS hour_created
    FROM "Model"
    WHERE "createdAt" > NOW() - INTERVAL '200 hour'
    GROUP BY date_trunc('hour', "createdAt")
    ORDER BY hour_created DESC;

### RRatingStats   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(ma.*), u."username", u."id" FROM "ModActivity" ma
    JOIN "User" u ON ma."userId" = u."id"
    WHERE ma."activity" = 'setNsfwLevel'
    GROUP BY u."username", u."id"
    ORDER BY 1 DESC

### RecentTagger   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      ma."activity",
      ma."createdAt",
      u."username"
    FROM "ModActivity" ma
    JOIN "User" u ON u."id" = ma."userId"
    WHERE "activity" = 'moderateTag'
    ORDER BY ma."createdAt" DESC
    LIMIT 1

### RecentReportImage   [SqlQueryUnified / Replicated_Read_Prod] 
    select 
      r."status", 
      r."statusSetAt", 
      u."username" 
    from "Report" r
    join "User" u ON u."id" = r."statusSetBy"
    where r."statusSetBy" IS NOT NULL
    and r."details" ->> 'reportType' = 'image'
    order by r."statusSetAt" desc
    limit 1

### RecentReports   [SqlQueryUnified / Replicated_Read_Prod] 
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'models' as type
    FROM
      "Report" r
      JOIN "ModelReport" rr ON r."id" = rr."reportId"
      JOIN "Model" e ON e."id" = rr."modelId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
      ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'images' as type
    FROM
      "Report" r
      JOIN "ImageReport" rr ON r."id" = rr."reportId"
      JOIN "Image" e ON e."id" = rr."imageId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'posts' as type
    FROM
      "Report" r
      JOIN "PostReport" rr ON r."id" = rr."reportId"
      JOIN "Post" e ON e."id" = rr."postId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'bounties' as type
    FROM
      "Report" r
      JOIN "BountyReport" rr ON r."id" = rr."reportId"
      JOIN "Bounty" e ON e."id" = rr."bountyId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'bountyEntries' as type
    FROM
      "Report" r
      JOIN "BountyEntryReport" rr ON r."id" = rr."reportId"
      JOIN "BountyEntry" e ON e."id" = rr."bountyEntryId"
      JOIN "Bounty" b ON b."id" = e."bountyId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'articles' as type
    FROM
      "Report" r
      JOIN "ArticleReport" rr ON r."id" = rr."reportId"
      JOIN "Article" e ON e."id" = rr."articleId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'users' as type
    FROM
      "Report" r
      JOIN "UserReport" rr ON r."id" = rr."reportId"
      JOIN "User" e ON e."id" = rr."userId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
     r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'collections' as type
    FROM
      "Report" r
      JOIN "CollectionReport" rr ON r."id" = rr."reportId"
      JOIN "Collection" e ON e."id" = rr."collectionId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'comments' as type
    FROM
      "Report" r
      JOIN "CommentReport" rr ON r."id" = rr."reportId"
      JOIN "Comment" e ON e."id" = rr."commentId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'commentV2' as type
    FROM
      "Report" r
      JOIN "CommentV2Report" rr ON r."id" = rr."reportId"
      JOIN "CommentV2" e ON e."id" = rr."commentV2Id"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'reviews' as type
    FROM
      "Report" r
      JOIN "ResourceReviewReport" rr ON r."id" = rr."reportId"
      JOIN "ResourceReview" e ON e."id" = rr."resourceReviewId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)
    
    UNION ALL
    
    (SELECT
      r."statusSetAt",
      umod."username" AS statusSetByUsername,
      'chats' as type
    FROM
      "Report" r
      JOIN "ChatReport" rr ON r."id" = rr."reportId"
      JOIN "Chat" e ON e."id" = rr."chatId"
      JOIN "User" umod ON r."statusSetBy" = umod."id"
      WHERE r."status" != 'Pending'
    ORDER BY r."statusSetAt" DESC
      LIMIT 1)

### Reports   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT * FROM (
        SELECT COUNT(*) AS count, 'models' AS type, 1 AS order_column FROM "Report" r
        JOIN "ModelReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
        AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'comments' AS type, 2 FROM "Report" r
        JOIN "CommentReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
        AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'commentV2' AS type, 3 FROM "Report" r
        JOIN "CommentV2Report" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
        AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'reviews' AS type, 4 FROM "Report" r
        JOIN "ResourceReviewReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'articles' AS type, 5 FROM "Report" r
        JOIN "ArticleReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'posts' AS type, 6 FROM "Report" r
        JOIN "PostReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'users' AS type, 7 FROM "Report" r
        JOIN "UserReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'collections' AS type, 8 FROM "Report" r
        JOIN "CollectionReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'bounties' AS type, 9 FROM "Report" r
        JOIN "BountyReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'bountyEntries' AS type, 10 FROM "Report" r
        JOIN "BountyEntryReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
        UNION ALL
        SELECT COUNT(*), 'chats' AS type, 11 FROM "Report" r
        JOIN "ChatReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
      UNION ALL
        SELECT COUNT(*), 'comics' AS type, 12 FROM "Report" r
        JOIN "ComicProjectReport" rt ON r."id" = rt."reportId"
        WHERE "status" = 'Pending'
      AND reason != 'Automated'
    ) AS subquery
    ORDER BY order_column;

### OLDReports   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      (SELECT COUNT(*) FROM "Report" r
      JOIN "ModelReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Model",
      
      (SELECT COUNT(*) FROM "Report" r
      JOIN "CommentReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Comment",
      
      (SELECT COUNT(*) FROM "Report" r
      JOIN "CommentV2Report" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "CommentV2",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "ResourceReviewReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "ResourceReview",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "ArticleReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Article",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "PostReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Post",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "UserReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "User",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "CollectionReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Collection",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "BountyReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Bounty",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "BountyEntryReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "BountyEntry",
    
      (SELECT COUNT(*) FROM "Report" r
      JOIN "ChatReport" rt ON r."id" = rt."reportId"
      WHERE "status" = 'Pending') AS "Chat"

### RecentRating   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      ma."activity",
      ma."createdAt",
      u."username"
    FROM "ModActivity" ma
    JOIN "User" u ON u."id" = ma."userId"
    WHERE "activity" = 'setNsfwLevel'
    ORDER BY ma."createdAt" DESC
    LIMIT 1

### MinorInsert   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### PoITimers   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'poi'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### PoIInsert   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### ModelTimer   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'models'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### pg   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### pg13   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### r   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### x   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### xxx   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### ResearchRating   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(rr.*), u."username" FROM "research_ratings" rr
    JOIN "User" u ON u."id" = rr."userId"
    GROUP BY u."username"
    ORDER BY 1 DESC

### RatingTaggers   [SqlQueryUnified / Replicated_Read_Prod] 
    select count(iir.*), u."username"
    FROM "ImageRatingRequest" iir
    join "User" u ON u."id" = iir."userId"
    group by u."username"
    order by 1 desc

### TaggerRatio   [SqlQueryUnified / Replicated_Read_Prod] 
    WITH data AS (
      SELECT
        u."username",
        SUM(CASE WHEN iir."status" = 'Actioned' AND i."nsfwLevel" = iir."nsfwLevel" THEN 1 ELSE 0 END) AS successful_count,
        SUM(CASE WHEN iir."status" = 'Actioned' AND i."nsfwLevel" != iir."nsfwLevel" THEN 1 ELSE 0 END) AS failed_count
      FROM 
        "ImageRatingRequest" iir
      JOIN 
        "Image" i ON i."id" = iir."imageId"
      JOIN 
        "User" u ON u."id" = iir."userId"
      GROUP BY 
        u."username"
    )
    
    SELECT 
      data.username,
      data.successful_count,
      CASE 
        WHEN (data.successful_count + data.failed_count) > 0 THEN (data.successful_count * 100.0) / (data.successful_count + data.failed_count) 
        ELSE 0 
      END AS success_rate
    FROM 
      data
    WHERE data.successful_count > 10
    ORDER BY 
      success_rate DESC;

### ModelCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: ModelTimer.data.lastUpdate[0]
    SELECT COUNT(*) FROM "Model" WHERE "publishedAt" > {{ModelTimer.data.lastUpdate[0]}}
    AND "status" = 'Published'

### ModelInsert   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### LogSHA256   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ModerationSHA

### TaskCheckerBlocked   [SqlQueryUnified / retool_db] 
    SELECT "lastUpdate", "lastUpdateBy" FROM "Mods_TaskTimers" 
    WHERE "task" = 'blockedImages'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### BlockedImagesTask   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: TaskCheckerBlocked.data.lastUpdate[0]
    select 
      COUNT(*)
    from "Image" 
    where "ingestion" = 'Blocked' 
    AND "blockedFor" != 'moderated'
    AND "blockedFor" != 'Moderated'
    and "blockedFor" != 'CSAM'
    and "blockedFor" != 'AiNotVerified'
    and "createdAt" > {{TaskCheckerBlocked.data.lastUpdate[0]}}

### CivitModelInsert   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### CivitModelCheck   [SqlQueryUnified / retool_db] 
    SELECT * FROM "Mods_TaskTimers" 
    WHERE "task" = 'civitaiModels'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### CivitModelsData   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: CivitModelCheck.data.lastUpdate[0]
    SELECT * FROM "Model" 
    WHERE "userId" = -1 
    AND "updatedAt" > {{CivitModelCheck.data.lastUpdate[0]}} 
    AND "status" = 'Published'

### TrainingCount   [SqlQueryUnified / Replicated_Read_Prod] 
    select
      COUNT(*)
    from "Model" m
      join "ModelVersion" mv on m.id = mv."modelId"
      join "ModelFile" mf on mf."modelVersionId" = mv.id
    where
      mv."trainingStatus" = 'Paused'
      and mf.type = 'Training Data'

### UrgentReports   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
        t.*, 
        ir."imageId" AS imageId,
        mr."modelId" AS modelId,
        ur."userId" AS userId,
        pr."postId",
        ar."articleId",
        u."username"
    FROM public."Report" t
    LEFT JOIN public."ImageReport" ir ON t.id = ir."reportId"
    LEFT JOIN public."ModelReport" mr ON t.id = mr."reportId"
    LEFT JOIN public."UserReport" ur ON t.id = ur."reportId"
    LEFT JOIN "PostReport" pr ON t.id = pr."reportId"
    LEFT JOIN "ArticleReport" ar ON t.id = ar."reportId"
    LEFT JOIN "Image" i ON i."id" = ir."imageId"
    JOIN "User" u ON u."id" = t."userId"
    WHERE t.status = 'Pending'
        AND array_length(t."alsoReportedBy", 1) > 1
        AND t."createdAt" > (now() - interval '1 week')
        AND i."blockedFor" IS NULL
    ORDER BY array_length(t."alsoReportedBy", 1) DESC, t."createdAt" DESC

### ActionReport   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, reportId, actionTaken, current_user.metadata.userIdCivit
    https://civitai.com/api/mod/action-report?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### blockedTagInsert   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### blockedTagTimer   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'blockedTag'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### ActionAllPostReports   [SqlQueryUnified / Replicated_Read_Prod] 
    WITH targets AS (
      SELECT 
        r.id AS report_id,
        i."nsfwLevel"
      FROM "Report" r
      JOIN "PostReport" pr ON pr."reportId" = r.id
      JOIN "Image" i ON i."postId" = pr."postId"
      WHERE r.status = 'Pending'
    )
    SELECT
      report_id
    FROM targets
    GROUP BY report_id
    HAVING COUNT(*) = COUNT(CASE WHEN "nsfwLevel" = 32 THEN 1 END);

### TagTimerCatchup   [SqlQueryUnified / retool_db] 
    WITH RankedFrontPageTimers AS (
        SELECT
            "lastCheckedAt",
            "username",
            "buttonPressedTime",
            "nsfw",
            ROW_NUMBER() OVER (PARTITION BY nsfw ORDER BY "lastCheckedAt" DESC) AS RowNum
        FROM
            "FrontPageTimers_catchup"
        WHERE
            nsfw IN ('1', '2', '4', '8', '16')
    )
    SELECT
        "lastCheckedAt",
        "username",
        "buttonPressedTime",
        "nsfw"
    FROM
        RankedFrontPageTimers
    WHERE
        RowNum = 1
    ORDER BY
        "lastCheckedAt" DESC
    LIMIT 5;

### FPATaskTimers_catchup   [SqlQueryUnified / retool_db] 
    WITH RankedFrontPageTimers AS (
        SELECT
            "task",
            "lastUpdate",
            "lastUpdateBy",
            ROW_NUMBER() OVER (PARTITION BY task ORDER BY "lastUpdate" DESC) AS RowNum
        FROM
            "Mods_TaskTimers"
        WHERE
            task IN ('1_catchup', '2_catchup', '4_catchup', '8_catchup', '16_catchup')
    )
    SELECT
        "task",
        "lastUpdate",
        "lastUpdateBy"
    FROM
        RankedFrontPageTimers
    WHERE
        RowNum = 1
    ORDER BY
        "lastUpdate" DESC
    LIMIT 5;

### GetSplitQueue   [SqlQueryUnified / retool_db] 
    SELECT "lastCheckedAt" 
    FROM "FrontPageTimers"
    WHERE username = 'splitQueue'
    ORDER BY "lastCheckedAt" desc
    LIMIT 1

### ImageSfwDataCatchup   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: formatDataAsArray(TagTimerCatchup.data).find(i=> i.nsfw == 1).lastCheckedAt, GetSplitQueue.data.lastCheckedAt[0]
    SELECT
      "id",
      "nsfw",
      "ingestion",
      "nsfwLevel"
    FROM "Image"
    WHERE "createdAt" > {{ formatDataAsArray(TagTimerCatchup.data).find(i=> i.nsfw == 1).lastCheckedAt }}
    AND "createdAt" < {{ GetSplitQueue.data.lastCheckedAt[0] }}

### pg_catchup   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### MuteStats   [SqlQueryUnified / retool_db] 
    SELECT
      SUM(CASE WHEN "ActionType" ILIKE 'UNMUTE%' THEN 1 ELSE 0 END) AS unmutes,
      SUM(CASE WHEN "ActionType" ILIKE 'VERIFY MUTE%' THEN 1 ELSE 0 END) AS mutes
    FROM "ReToolActions"
    WHERE "App" ILIKE '%Prompt Checker%'
    AND "Event" > '2024-07-19 00:01:00';

### newUserInsert   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: Mods_TaskTimers

### newUserTimer   [SqlQueryUnified / retool_db] 
    SELECT 
      "lastUpdate",
      "lastUpdateBy"
    FROM "Mods_TaskTimers" 
    WHERE "task" = 'newUser'
    ORDER BY "lastUpdate" DESC
    LIMIT 1

### UnpublishingReasons   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
        CAST(m.meta->>'unpublishedAt' as date) as date,
        m.meta->>'customMessage',
        u.username
    FROM "Model" m
    JOIN "User" u ON u.id = CAST(m.meta->>'unpublishedBy' as int)
    WHERE status = 'UnpublishedViolation'
    AND COALESCE(m.meta->>'unpublishedReason', 'other') = 'other'
    ORDER BY m."publishedAt"

### SplitCatchup   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: FrontPageTimers_catchup

### SplitCurrent   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: FrontPageTimers

### LookUpTags   [SqlQueryUnified / Replicated_Read_Prod] 
    -- (From lib/LookUpTags.sql) Lookup images with certain tags; returns civitai URL.
    SELECT 
    
    concat('https://www.civitai.red/images/', toi1."imageId")
    FROM "TagsOnImage" toi1
    JOIN "TagsOnImage" toi2 ON toi1."imageId" = toi2."imageId"
    JOIN "TagsOnImage" toi3 ON toi1."imageId" = toi3."imageId"
    JOIN "TagsOnImage" toi4 ON toi1."imageId" = toi4."imageId"
    JOIN "TagsOnImage" toi5 ON toi1."imageId" = toi5."imageId"
      
    WHERE toi1."tagId" = 5232
      AND toi2."tagId" = 5133
      AND toi3."tagId" = 5262
      AND toi4."tagId" = 114923
      AND toi5."tagId" = 5231
      order by toi1."createdAt" desc
    limit 200

### FindSHA   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
      m.id,
      mf."rawScanResult" -> 'hashes' ->> 'SHA256' AS hashes
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mv.id = mf."modelVersionId"
    WHERE m.status = 'UnpublishedViolation'
    OR m."deletedAt" IS NOT NULL
    ORDER BY ID

### ReviewGrouped   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      "needsReview",
      COUNT(*)
    FROM (
      SELECT "needsReview" FROM "Image"
      WHERE "needsReview" IS NOT NULL AND (("needsReview" != 'appeal' AND "ingestion" = 'Scanned') OR "needsReview" = 'appeal')
    
      UNION ALL
    
      SELECT 'reported' AS "needsReview" FROM (
        SELECT ir."imageId" FROM "Report" r
        JOIN "ImageReport" ir ON ir."reportId" = r.id
        WHERE r.status = 'Pending'
        GROUP BY ir."imageId"
      )
    )
    GROUP BY "needsReview";

### ErrorRatingQueue   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
        COUNT(*)
    FROM "Image" i
    WHERE "createdAt" > now() - INTERVAL '2 days'
    AND "createdAt" < now() - interval '1 hour'
    AND ingestion IN ('Error'::"ImageIngestionStatus")
    AND "nsfwLevel" = 0

### AutoBlockedUsers   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT ma.*, u.username
    FROM "ModActivity" ma
    JOIN "User" u ON u.id = ma."entityId"
    WHERE activity = 'autoMuteScam' 
    ORDER BY ma."createdAt" DESC;

### ComicReview   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(DISTINCT cp.id)
    FROM "ComicPanel" cp
    JOIN "Image" i ON cp."imageId" = i.id
    WHERE i."needsReview" IS NOT NULL
       OR i.ingestion != 'Scanned'
       OR i."tosViolation" = true;

### ArticleReview   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*) FROM "ArticleRatingReview"
    WHERE status = 'Pending'

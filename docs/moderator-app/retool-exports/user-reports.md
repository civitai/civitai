# user-reports.json

queries: 34   components: 57
resources: JavascriptQuery, REST-WithoutResource, retool_db, Replicated_Read_Prod, Clickhouse

## component types (scale signal; the structure itself is below)
  ButtonWidget2: 17
  Function: 7
  TextWidget2: 7
  TableWidget2: 5
  TextAreaWidget: 4
  State: 3
  TextInputWidget2: 3
  ModalFrameWidget: 2
  ContainerWidget2: 2
  Frame: 1
  CustomComponentWidget: 1
  RadioGroupWidget2: 1
  CheckboxWidget2: 1
  ProgressBarWidget: 1
  DrawerFrameWidget: 1
  TabsWidget2: 1

## tabs & option sets — READ THESE, they are functionality
  Tab labels are the app's table of contents; dropdown options are canned workflows that
  exist in no query. A tab you did not port is a capability you did not port.

### tabbedContainer1   [ContainerWidget2]
    - ModActivity({{ ModActTable.value.length }})
    - Reports({{ ReceivedReports.data.id.length }})
    - UserReport History

### tabs1   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

### group1   [ContainerWidget2] — 1 pane(s)
  - "View 1"  [bd48f]
      c 3 w 5  text7 [TextWidget2]
      c 0 w12  progressBar1 [ProgressBarWidget]

### tabbedContainer1   [ContainerWidget2] — 3 pane(s), tab bar tabs1
  - "ModActivity({{ ModActTable.value.length }})"  [aa085]
      c 0 w12  tabs1 [TabsWidget2]
      c 0 w12  table5 [TableWidget2]
  - "Reports({{ ReceivedReports.data.id.length }})"  [db4e2]
      c 0 w12  table4 [TableWidget2]
  - "UserReport History"  [39659]
      c 0 w12  table3 [TableWidget2]

## queries

### query30   [JavascriptQuery / JavascriptQuery] 
    let i = 0;
    let batchSize = 10
    
    TriggerQuery(i);
    
    function TriggerQuery(i) {
      if (i >= customComponent1.model.selectedImages.length) {
        console.log('hello im done')
        return
      }
    
      RemoveImages2.trigger({
        additionalScope: { imageIds: customComponent1.model.selectedImages.slice(i, i + batchSize) },
        onSuccess: function() {
          TriggerQuery(i + batchSize);
        }
      });
    
      
    }

### RemoveImages2   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, imageIds, current_user.metadata.userIdCivit
    https://civitai.com/api/mod/remove-images?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### DisableAppRestore   [JavascriptQuery / JavascriptQuery] 
    //flip disable app toggle
    customComponent1.updateModel({ isDisabled: true })

### RestoreImages   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, customComponent1.model.selectedImages, current_user.metadata.userIdCivit
    https://civitai.com/api/mod/restore-images?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### LogRestore   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### DisableApp   [JavascriptQuery / JavascriptQuery] 
    //flip disable app toggle
    customComponent1.updateModel({ isDisabled: true })

### RemoveImages   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, body.value
    https://civitai.com/api/mod/remove-images?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### LogTos   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### SendCorrectNotif   [JavascriptQuery / JavascriptQuery] 
    SendNotification2.trigger();

### SendNotification2   [RESTQuery / REST-WithoutResource] 
    depends on: token, key, userId, type, details, category
    https://civitai.com/api/mod/send-mod-notification?token={{ token }}

### PostNotification   [RESTQuery / REST-WithoutResource] 
    depends on: token, key, userId, type, details, category
    https://civitai.com/api/mod/send-mod-notification?token={{ token }}

### InsertStrike   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: UserStrikes

### LogStrike   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### UpdateAfterDelete   [JavascriptQuery / JavascriptQuery] 
    const selectedImages = customComponent1.model.selectedImages
    
    handleImageDelete(selectedImages)
    handleFilteredImageDelete(selectedImages)
    
    function handleImageDelete(imageIds){
    
      const updatedImages = [...customComponent1.model.images];
      
      for(const imageId of imageIds){
        const imageToUpdate = updatedImages.find(image => image.id === imageId)
    
        imageToUpdate.blockedFor = 'moderated'
        imageToUpdate.ingestion = 'Blocked'
        imageToUpdate.nsfwLevel = 32
    
        customComponent1.updateModel({ images: updatedImages });
      }
    }
    
    function handleFilteredImageDelete(imageIds){
    
      const updatedImages = [...customComponent1.model.filteredImages];
      
      for(const imageId of imageIds){
        const imageToUpdate = updatedImages.find(image => image.id === imageId)
    
        imageToUpdate.blockedFor = 'moderated'
        imageToUpdate.ingestion = 'Blocked'
        imageToUpdate.nsfwLevel = 32
    
        customComponent1.updateModel({ filteredImages: updatedImages });
      }
    }

### UserStrikes   [SqlQueryUnified / retool_db] 
    depends on: userid.value
    SELECT * FROM "UserStrikes" WHERE "userId" = {{userid.value}}

### UserQuery   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userid.value
    SELECT
      i."url",
      i."id",
      i."createdAt",
      i."name",
      i."ingestion",
      i."blockedFor",
      i."needsReview",
      i."userId",
      i."nsfwLevel",
      COALESCE(
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450,quality=90/' || REPLACE(i."name", '%', ''),
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450,quality=90/random.jpg'
      ) AS "Source",
      'https://civitai.red/images/' || i."id" AS "Link",
      i."meta" ->> 'prompt' AS "Prompt",
      u."profilePictureId" AS profile,
      ic."entityId" AS bounty,
      i."meta" ->> 'negativePrompt' AS "negativePrompt"
    FROM
      "Image" i
    LEFT JOIN "User" u ON u."profilePictureId" = i."id" 
    LEFT JOIN "ImageConnection" ic ON ic."entityId" = i."id"
    WHERE
      i."userId" = {{userid.value}}
    ORDER BY
      i."createdAt" DESC

### UsernameQuery   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: username.value
    SELECT "id" FROM "User"
    WHERE "username" = {{ username.value }}

### EnableApp   [JavascriptQuery / JavascriptQuery] 
    //flip disable app toggle
    customComponent1.updateModel({ isDisabled: false })

### TOSImages   [JavascriptQuery / JavascriptQuery] 
    //doesnt run anywhere, just a test
    
    if (customComponent1.model.selectedImages.length > 0) {
      setTimeout(async () => {
        try {
          await DisableApp.trigger();
          await RemoveImages.trigger();
          await SendNotification2.trigger();
          await UpdateAfterDelete.trigger();
          await EnableApp.trigger();
          await UnselectAll.trigger();
        } catch (error) {
          console.error("Error:", error);
          await utils.showNotification({ 
            title: "Error", 
            description: `Something went wrong, tell Seb`, 
            notificationType: "error", 
            duration: 10 })
    
          EnableApp.trigger();
        }
      }, 100); // Adjust the delay as needed
    
      
    }

### UnselectAll   [JavascriptQuery / JavascriptQuery] 
    customComponent1.updateModel({selectedImages: []})
    strikeCheckbox.setValue(false)

### UpdateAfterRestore   [JavascriptQuery / JavascriptQuery] 
    const selectedImages = customComponent1.model.selectedImages
    
    handleImageRestore(selectedImages)
    handleFilteredImageRestore(selectedImages)
    
    function handleImageRestore(imageIds){
    
      const updatedImages = [...customComponent1.model.images];
      
      for(const imageId of imageIds){
        const imageToUpdate = updatedImages.find(image => image.id === imageId)
    
        imageToUpdate.blockedFor = null
        imageToUpdate.ingestion = 'Scanned'
    
        customComponent1.updateModel({ images: updatedImages });
      }
    }
    
    function handleFilteredImageRestore(imageIds){
    
      const updatedImages = [...customComponent1.model.filteredImages];
      
      for(const imageId of imageIds){
        const imageToUpdate = updatedImages.find(image => image.id === imageId)
    
        imageToUpdate.blockedFor = null
        imageToUpdate.ingestion = 'Scanned'
    
        customComponent1.updateModel({ filteredImages: updatedImages });
      }
    }

### EnableApp2   [JavascriptQuery / JavascriptQuery] 
    //flip disable app toggle
    customComponent1.updateModel({ isDisabled: false })

### UnselectAll2   [JavascriptQuery / JavascriptQuery] 
    customComponent1.updateModel({selectedImages: []})

### query31   [JavascriptQuery / JavascriptQuery] 
    let i = 0;
    let batchSize = 5
    
    TriggerQuery(i);
    
    function TriggerQuery(i) {
      if (i >= customComponent1.model.selectedImages.length) {
        return
      }
    
      log.trigger({
        additionalScope: { imageIds: customComponent1.model.selectedImages.slice(i, i + batchSize) },
        onSuccess: function() {
          TriggerQuery(i + batchSize);
        }
      });
    }

### log   [JavascriptQuery / JavascriptQuery] 
    console.log(imageIds)

### GetReports   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      r.id,
      ur."userId",
      r."createdAt",
      CASE
        WHEN r.details ->> 'violation' IS NOT NULL THEN r.details ->> 'violation'
        ELSE r.details ->> 'reason'
      END AS violation_or_reason,
      r.details ->> 'comment' AS comment,
      r."alsoReportedBy",
      r.status,
      u.username,
      utos."deletedAt",
      utos."bannedAt",
      utos."mutedAt",
      utos.username AS suspect
    FROM "Report" r 
    JOIN "UserReport" ur ON r.id = ur."reportId"
    JOIN "User" u ON u.id = r."userId"
    JOIN "User" utos ON utos.id = ur."userId"
    WHERE r.status IN('Pending', 'Processing')
    AND reason != 'Automated'
    ORDER BY r."createdAt" DESC

### ReportHistory   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
      r."statusSetAt",
      u.username,
      r.status,
      pr."userId"
    FROM
    "Report" r
    JOIN "UserReport" pr ON pr."reportId" = r.id
    JOIN "User" u ON u.id = r."statusSetBy"
    ORDER BY "statusSetAt" DESC
    LIMIT 300

### ActionReport   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, reportId, actionTaken, current_user.metadata.userIdCivit
    https://civitai.com/api/mod/action-report?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### GetImageCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: formatDataAsArray(GetReports.data).filter(i=> i.status === 'Pending').map(i=>i.userId)
    SELECT
        COUNT(*) as total,
        --COUNT(CASE WHEN i."nsfwLevel" != 32 THEN 1 END) as remaining,
        "userId"
    FROM "Image" i
    WHERE i."userId" = ANY({{ formatDataAsArray(GetReports.data).filter(i=> i.status === 'Pending').map(i=>i.userId) }})
    GROUP BY "userId"

### ReceivedReports   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userid.value
    SELECT
      r.*,
      rr."modelId" AS entityId,
      'Model' AS entityType,
      concat('https://civitai.com/models/' || rr."modelId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ModelReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Model" e ON e."id" = rr."modelId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."imageId" AS entityId,
      'Image' AS entityType,
      concat('https://civitai.com/images/' || rr."imageId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ImageReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Image" e ON e."id" = rr."imageId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."postId" AS entityId,
      'Post' AS entityType,
      concat('https://civitai.com/posts/' || rr."postId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "PostReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Post" e ON e."id" = rr."postId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."bountyId" AS entityId,
      'Bounty' AS entityType,
      concat('https://civitai.com/bounties/' || rr."bountyId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "BountyReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Bounty" e ON e."id" = rr."bountyId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."bountyEntryId" AS entityId,
      'BountyEntry' AS entityType,
      concat('https://civitai.com/bounties/' || b."id" || '/entries/' || rr."bountyEntryId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "BountyEntryReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "BountyEntry" e ON e."id" = rr."bountyEntryId"
      LEFT JOIN "Bounty" b ON b."id" = e."bountyId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."articleId" AS entityId,
      'Article' AS entityType,
      concat('https://civitai.com/articles/' || rr."articleId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ArticleReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Article" e ON e."id" = rr."articleId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."userId" AS entityId,
      'User' AS entityType,
      concat('https://civitai.com/user/' || e."username") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "UserReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "User" e ON e."id" = rr."userId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."id" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."collectionId" AS entityId,
      'Collection' AS entityType,
      concat('https://civitai.com/collections/' || rr."collectionId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "CollectionReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Collection" e ON e."id" = rr."collectionId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."commentId" AS entityId,
      'Comment' AS entityType,
      concat('https://civitai.com/models/' || 'TellSebIfThisNeedsToWork') AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "CommentReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Comment" e ON e."id" = rr."commentId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."commentV2Id" AS entityId,
      'CommentV2' AS entityType,
      concat('https://civitai.com/models/' || 'TellSebIfThisNeedsToWork') AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "CommentV2Report" rr ON r."id" = rr."reportId"
      LEFT JOIN "CommentV2" e ON e."id" = rr."commentV2Id"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."resourceReviewId" AS entityId,
      'ResourceReview' AS entityType,
      concat('https://civitai.com/reviews/' || rr."resourceReviewId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ResourceReviewReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "ResourceReview" e ON e."id" = rr."resourceReviewId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userid.value}}

### ClickhouseUserActivities   [SqlQuery / Clickhouse] 
    depends on: userid.value
    SELECT
      CASE
        "type"
        WHEN 1 THEN 'Registration'
        WHEN 2 THEN 'Account closure'
        WHEN 3 THEN 'Subscribe'
        WHEN 4 THEN 'Cancel'
        WHEN 5 THEN 'Donate'
        WHEN 6 THEN 'Adjust Moderated Content Settings'
        WHEN 7 THEN 'Banned'
        WHEN 8 THEN 'Unbanned'
        WHEN 9 THEN 'Muted'
        WHEN 10 THEN 'Unmuted'
        WHEN 11 THEN 'RemoveContent'
        ELSE 'Unknown'
      END AS details,
      "time" AS createdAt,
      "userId" AS modName,
      null AS entityId,
      'Account' AS entityTyp,
      null AS reason
    FROM
      "default"."userActivities"
    WHERE
      "targetUserId" = {{userid.value}}
      AND NOT "userId" = {{userid.value}}
      AND NOT "type" = 14
    UNION ALL
    SELECT
      CASE
        "type"
        WHEN 1 THEN 'Create'
        WHEN 2 THEN 'Delete'
        WHEN 3 THEN 'DeleteTOS'
        WHEN 4 THEN 'Tags'
        WHEN 5 THEN 'Resources'
        ELSE 'Unknown'
      END AS details,
      "time" AS createdAt,
      "userId" AS modName,
      "imageId" AS entityId,
      'Image' AS entityType,
      "tosReason" AS reason
    FROM
      "default"."images"
    WHERE
      "ownerId" = {{userid.value}}
      AND NOT "userId" = {{userid.value}}
    ORDER BY
      "time" DESC

### RetoolActions   [SqlQueryUnified / retool_db] 
    depends on: userid.value
    SELECT
      "ActionType" AS details,
      "Event" AS createdAt,
      "User" AS modName
    FROM
      "ReToolActions"
    WHERE
      "ActionType" LIKE '%' || {{userid.value}} || '%'

### RetoolNotes   [SqlQueryUnified / retool_db] 
    depends on: userid.value
    SELECT
      "notes" AS details,
      "lastUpdate" AS createdAt,
      "lastUpdateBy" AS modName
    FROM
      "UserNotes"
    WHERE
      "userId" = {{userid.value}}

### UserQuery5000   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userid.value
    SELECT
      i."url",
      i."id",
      i."createdAt",
      i."name",
      i."ingestion",
      i."blockedFor",
      i."needsReview",
      i."userId",
      i."nsfwLevel",
      COALESCE(
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450,quality=90/' || REPLACE(i."name", '%', ''),
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450,quality=90/random.jpg'
      ) AS "Source",
      'https://civitai.red/images/' || i."id" AS "Link",
      i."meta" ->> 'prompt' AS "Prompt",
      u."profilePictureId" AS profile,
      ic."entityId" AS bounty,
      i."meta" ->> 'negativePrompt' AS "negativePrompt"
    FROM
      "Image" i
    LEFT JOIN "User" u ON u."profilePictureId" = i."id" 
    LEFT JOIN "ImageConnection" ic ON ic."entityId" = i."id"
    WHERE
      i."userId" = {{userid.value}}
    ORDER BY
      i."createdAt" DESC
    LIMIT 5000

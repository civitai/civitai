# Bulk Image Manager.json

queries: 40   components: 60
resources: JavascriptQuery, REST-WithoutResource, retool_db, Replicated_Read_Prod

## component types (layout is NOT ported — this is only a scale signal)
  ButtonWidget2: 15
  TextInputWidget2: 8
  Function: 7
  TextWidget2: 7
  TextAreaWidget: 6
  TableWidget2: 3
  State: 2
  ModalFrameWidget: 2
  ContainerWidget2: 2
  Frame: 1
  CustomComponentWidget: 1
  RadioGroupWidget2: 1
  CheckboxWidget2: 1
  ProgressBarWidget: 1
  DrawerFrameWidget: 1
  ToggleButtonWidget: 1
  JSONEditorWidget: 1

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
    if(postId.value !== ''){
      PostNotification.trigger();
    } else {
      SendNotification2.trigger();
    }

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

### PostQuery   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: postId.value
    SELECT
      p."id" as postid,
      i."url",
      i."id" AS id,
      i."createdAt" AS "createdAt",
      i."name", 
      i."ingestion",
      i."blockedFor",
      i."needsReview",
      i."userId",
      i."nsfwLevel",
      COALESCE('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || "url" || '/width=450,quality=90/' || "name", 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || url || '/width=450,quality=90/random.jpg' ) AS "Source",
      'https://civitai.red/images/' || i."id" AS "Link",
      p."id" postId,
      "meta" ->> 'prompt' AS "Prompt",
      "meta" ->> 'negativePrompt' AS "negativePrompt"
    FROM
      "Image" i
      JOIN "Post" p ON i."postId" = p."id"
    WHERE
      p."id" = {{postId.value}}
    ORDER BY
      i."createdAt" DESC
      LIMIT 200

### FindModelVersions   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: modelVersionId.value
    SELECT "id" FROM "ModelVersion"
    WHERE "modelId" = {{modelVersionId.value}}

### FindPosts   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: FindModelVersions.data.id
    SELECT
      "id"
    FROM
      "Post"
    WHERE
      "modelVersionId" = ANY ({{ FindModelVersions.data.id }})

### FindmagesFromPosts   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: FindPosts.data.id
    SELECT
      i."url",
      i."id" AS id,
      i."createdAt" AS "createdAt",
      i."name",
      i."ingestion",
      i."blockedFor",
      i."needsReview",
      i."userId",
    COALESCE('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || "url" || '/width=400/' || "name", 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || url || '/width=400/random.jpg' ) AS "Source",
      'https://civitai.com/images/' || i."id" AS "Link",
      p."id" postId,
      "meta" ->> 'prompt' AS "Prompt",
      "meta" ->> 'negativePrompt' AS "negativePrompt"
    FROM
      "Image" i
      JOIN "Post" p ON i."postId" = p."id"
    WHERE
      p."id" = ANY ({{ FindPosts.data.id }})
    ORDER BY
      i."createdAt" DESC
      LIMIT 200

### MVFindPost   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: modelVersionId.value
    SELECT
      "id"
    FROM
      "Post"
    WHERE
      "modelVersionId" = {{ modelVersionId.value }}

### MVFindImages   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: MVFindPost.data.id
    SELECT
      i."url",
      i."id" AS id,
      i."createdAt" AS "createdAt",
      i."name", 
      i."ingestion",
      i."blockedFor",
      i."needsReview",
      i."userId",
      COALESCE('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || "url" || '/width=400/' || "name", 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || url || '/width=400/random.jpg' ) AS "Source",
      'https://civitai.com/images/' || i."id" AS "Link",
      p."id" postId,
      "meta" ->> 'prompt' AS "Prompt"
    FROM
      "Image" i
      JOIN "Post" p ON i."postId" = p."id"
    WHERE
      p."id" = ANY ({{ MVFindPost.data.id }})
    ORDER BY
      i."createdAt" DESC
      LIMIT 200

### RunAtStart   [JavascriptQuery / JavascriptQuery] 
    (runs on page load)
    if(username.value !== ""){
      UsernameQuery.trigger();
    } else if(userid.value !== "") {
      UserQuery.trigger();
    } else if(modelId.value !== "") {
      FindModelVersions.trigger();
    } else if(modelVersionId.value !== "") {
      MVFindPost.trigger();
    } else if(postId.value !== "") {
      PostQuery.trigger();
    } else if(collectionId.value !== "") {
      CollectionQuery.trigger();
    }

### UserStrikes   [SqlQueryUnified / retool_db] 
    depends on: userid.value
    SELECT * FROM "UserStrikes" WHERE "userId" = {{userid.value}}

### CollectionQuery   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: collectionId.value
    SELECT
      i."url",
      i."id" AS id,
      i."createdAt" AS "createdAt",
      i."name", 
      i."ingestion",
      i."blockedFor",
      i."needsReview",
      i."userId",
      COALESCE('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || "url" || '/width=400/' || "name", 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || url || '/width=400/random.jpg' ) AS "Source",
      'https://civitai.com/images/' || i."id" AS "Link",
      "meta" ->> 'prompt' AS "Prompt"
    FROM
      "CollectionItem" ci
      JOIN "Image" i ON ci."imageId" = i."id"
    WHERE
      ci."collectionId" = {{collectionId.value}}
    ORDER BY
      i."createdAt" DESC
      LIMIT 200

### UserQuery   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userid.value
    SELECT
      i."mimeType",
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
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/transcode=true,original=true,quality=90/' || REPLACE(i."name", '%', ''),
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450/random.jpg'
      ) AS "Source",
      'https://civitai.red/images/' || i."id" AS "Link",
      i."meta" ->> 'prompt' AS "Prompt",
      u."profilePictureId" AS profile,
      ic."entityId" AS bounty,
      i."meta" ->> 'negativePrompt' AS "negativePrompt",
      i.poi
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

### ReportOnUser   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userid.value
    SELECT
      r.status,
      u.username AS "ReportedBy",
      r.reason,
      r.id,
      r."createdAt",
      r.details,
      r."alsoReportedBy",
      r."previouslyReviewedCount"
    FROM "UserReport" ur
    JOIN "Report" r ON r."id" = ur."reportId"
    JOIN "User" u ON u."id" = r."userId"
    WHERE ur."userId" = {{ userid.value }}
    AND r."status" = 'Pending'

### RestoreArrayOfImages   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, textArea4.value.split('\\n').map(i=>Number(i)), current_user.metadata.userIdCivit
    https://civitai.com/api/mod/restore-images?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### RemoveArrayOfImages   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, textArea5.value.split('\\n').filter(i=>i != 0).map(i=> Number(i)), current_user.metadata.userIdCivit
    https://civitai.com/api/mod/remove-images?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### nukeUser   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, nukeBody.value
    https://civitai.com/api/mod/remove-images?token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### GetBulkRemoveImageUserIdsForNotifs   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea5.value.split('\n').filter(i=>i != 0).map(i=> Number(i))
    select distinct "userId"
    from "Image"
    where id = any({{ textArea5.value.split('\n').filter(i=>i != 0).map(i=> Number(i)) }})

### query39   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea5.value.split('\n').filter(i=>i != 0).map(i=> Number(i))
    select "nsfwLevel"
    from "Image"
    where id = any({{ textArea5.value.split('\n').filter(i=>i != 0).map(i=> Number(i)) }})

### nukeUser3   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*)
    FROM "Image" i
    JOIN "ImageResource" ir ON ir."imageId" = i."id"
    WHERE ir."modelVersionId" IN (
        SELECT "id" 
        FROM "ModelVersion" 
        WHERE "modelId" = 206995
    )
    AND "needsReview" = 'poi'

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
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450/' || REPLACE(i."name", '%', ''),
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/' || i."url" || '/width=450/random.jpg'
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
      AND i."nsfwLevel" = 32
    ORDER BY
      i."createdAt" DESC
    LIMIT
      5000

### TogglePoIMakeSureToEdit   [RESTQuery / REST-WithoutResource] 
    depends on: retoolContext.configVars.WEBHOOK_TOKEN, customComponent1.model.selectedImages.join(',')
    https://civitai.com/api/mod/update-image-flag?token={{ retoolContext.configVars.WEBHOOK_TOKEN }}&flag=poi&value=true&ids={{ customComponent1.model.selectedImages.join(',') }}

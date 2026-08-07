# chat-audit.json

queries: 20   components: 50
resources: Replicated_Read_Prod, REST-WithoutResource, retool_db

## component types (layout is NOT ported — this is only a scale signal)
  TextWidget2: 12
  TableWidget2: 10
  ContainerWidget2: 8
  TextInputWidget2: 8
  State: 2
  SelectWidget2: 2
  KeyValueWidget2: 2
  TabsWidget2: 1
  Frame: 1
  ToggleButtonWidget: 1
  DividerWidget: 1
  ButtonWidget2: 1
  SwitchWidget2: 1

## tabs & option sets — READ THESE, they are functionality
  Tab labels are the app's table of contents; dropdown options are canned workflows that
  exist in no query. A tab you did not port is a capability you did not port.

### tabbedContainer1   [ContainerWidget2]
    - Chats
    - Chat Reports
    - Stats
    - Newest

### tabs1   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

## queries

### ChatReport   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
      r.*,
      cr.*,
      r."details" ->> 'comment'
    FROM "ChatReport" cr
    JOIN "Report" r ON r."id" = cr."reportId"
    WHERE reason != 'Automated'
    ORDER BY r."createdAt" DESC

### SearchMessages   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: chatContentSearch.value
    SELECT DISTINCT "chatId" FROM "ChatMessage" WHERE "content" ILIKE '%' || {{chatContentSearch.value}} || '%'

### SearchUser   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: chatUserSearch.value
    SELECT DISTINCT cm."chatId" 
    FROM "ChatMessage" cm
    JOIN "User" u ON cm."userId" = u."id"
    WHERE u."username" = {{chatUserSearch.value}}

### FindChats   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: chatIds.value
    SELECT 
        cm."chatId" AS "Chat Id",
        MAX(CASE WHEN cm."isOwner" = TRUE THEN u."bannedAt" END) AS ownerBannedAt,
        COALESCE(MAX(CASE WHEN cm."isOwner" = TRUE THEN u."username" END), MAX(CASE WHEN cm."isOwner" = TRUE THEN u."id"::text END)) AS owner,
        MAX(CASE WHEN cm."isOwner" = TRUE THEN u."id" END) AS ownerId,
        string_to_array(
            string_agg(COALESCE(u."username", u."id"::text), ',') FILTER (WHERE cm."isOwner" = FALSE),
            ','
        ) AS members
    FROM 
        "ChatMember" cm
    JOIN 
        "User" u ON u."id" = cm."userId"
    WHERE 
        cm."chatId" = ANY({{chatIds.value}})
    GROUP BY 
        cm."chatId"

### FindChatById   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: foundChats.selectedRowKey
    SELECT 
      cm."id",
      cm."chatId",
      cm."createdAt",
      cm."content",
      cm."userId",
      u."username"
    FROM "ChatMessage" cm
    JOIN "User" u ON u."id" = cm."userId"
    WHERE "chatId" = {{foundChats.selectedRowKey}}
    ORDER BY cm."createdAt" ASC

### FindChatMembers   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: chatTable.selectedRow.chatId
    SELECT 
      u."username"
    FROM "ChatMember" cm
    JOIN "User" u ON u."id" = cm."userId"
    WHERE "chatId" = {{chatTable.selectedRow.chatId}}

### ChatsTotal   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*)
    FROM "Chat"

### Chats24   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*)
    FROM "Chat" 
    WHERE "createdAt" > now() - INTERVAL '24 hour'

### MessagesTotal   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*)
    FROM "ChatMessage"
    WHERE NOT "userId" = -1

### Messages24   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*)
    FROM "ChatMessage" 
    WHERE "createdAt" > now() - INTERVAL '24 hour'
    AND NOT "userId" = -1

### TopChatters   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), u."username", u."id"
    FROM "ChatMessage" cm
    JOIN "User" u ON u."id" = cm."userId"
    WHERE NOT "userId" = -1 
    GROUP BY u."username", u."id"
    ORDER BY 1 DESC
    LIMIT 50

### TopChatters24   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), u."username", u."id"
    FROM "ChatMessage" cm
    JOIN "User" u ON u."id" = cm."userId"
    WHERE cm."createdAt" > now() - INTERVAL '24 hour'
    AND NOT "userId" = -1 
    GROUP BY u."username", u."id"
    ORDER BY 1 DESC
    LIMIT 50

### TopChats   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), "chatId"
    FROM "ChatMessage"
    GROUP BY "chatId"
    ORDER BY 1 DESC
    LIMIT 20

### TopChats24   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), "chatId"
    FROM "ChatMessage"
    WHERE "createdAt" > now() - INTERVAL '24 hour'
    GROUP BY "chatId"
    ORDER BY 1 DESC
    LIMIT 20

### NewestMessages   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: numberOfMessages.value
    SELECT 
      cm."content",
      cm."createdAt",
      cm."chatId",
      u."username"
    FROM "ChatMessage" cm
    JOIN "User" u ON u."id" = cm."userId"
    ORDER BY "createdAt" DESC
    LIMIT {{numberOfMessages.value}}

### UserDetails   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
      cm."createdAt",
      cm."chatId",
      cm."content",
      u."username",
      u."id" AS userId,
      u."bannedAt"
    FROM "ChatMessage" cm
    JOIN "User" u ON u."id" = cm."userId"
    WHERE cm."userId" = {{userIdVar.value}}

### BANAPI   [RESTQuery / REST-WithoutResource] 
    depends on: UserDetails.data.userid[0], retoolContext.configVars.WEBHOOK_TOKEN
    https://www.civitai.com/api/mod/ban-user?userId={{UserDetails.data.userid[0]}}&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### SetNote   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: UserNotes

### LogBan   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### SPAMDetect   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      cm."content",
      cm."userId",
      u."username",
      MAX(u."bannedAt") AS "bannedAt", -- Get the maximum value of bannedAt
      COUNT(DISTINCT cm."chatId") AS chatCount
    FROM "ChatMessage" cm
    JOIN "User" u ON u."id" = cm."userId"
    WHERE cm."userId" != -1 -- Exclude system user
    GROUP BY cm."content", cm."userId", u."username"
    HAVING COUNT(DISTINCT cm."chatId") > 1

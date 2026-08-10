# chat-audit.json

queries: 20   components: 50
resources: Replicated_Read_Prod, REST-WithoutResource, retool_db

## component types (scale signal; the structure itself is below)
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

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

### tabbedContainer1   [ContainerWidget2] — 6 pane(s), tab bar tabs1
  - "Chats"  [2389b]
      c 0 w12  foundChats [TableWidget2]
      c 0 w 3  text4 [TextWidget2]
      c 3 w 3  text2 [TextWidget2]
      c 6 w 6  text3 [TextWidget2]
      c 1 w10  divider1 [DividerWidget]
      c 1 w 3  select2 [SelectWidget2] "Username"
      c 4 w 7  textInput1 [TextInputWidget2] "Chat Content Search"
      c 0 w12  chatTable [TableWidget2]
  - "Chat Reports"  [da0b8]
      c 0 w 3  select1 [SelectWidget2] "Status"
      c 0 w12  reportTable [TableWidget2]
  - "Stats"  [a2e3a]
      c 0 w 6  container2 [ContainerWidget2]
      c 6 w 6  container3 [ContainerWidget2]
      c 0 w 6  container4 [ContainerWidget2]
      c 6 w 6  container6 [ContainerWidget2]
      c 6 w 6  container7 [ContainerWidget2]
      c 0 w 6  container5 [ContainerWidget2]
  - "Newest"  [af9a1]
      c 0 w 3  numberOfMessages [TextInputWidget2] "# of Messages"
      c 3 w 9  textInput2 [TextInputWidget2] "Chat Content Search"
      c 0 w12  table5 [TableWidget2]
  - "Send Mod Chat"  [9f0d6]  — empty
  - "SPAM Detector"  [2f1a6]
      c 0 w 6  textInput3 [TextInputWidget2] "Search Content"
      c 7 w 5  switch1 [SwitchWidget2] "Hide Banned Users"
      c 0 w12  table9 [TableWidget2]
      c 0 w12  tabs1 [TabsWidget2]   (not in a pane)

### container2   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [fec2b]
      c 0 w12  keyValue1 [KeyValueWidget2]
      c 0 w12  containerTitle2 [TextWidget2]   (not in a pane)

### container3   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [fec2b]
      c 0 w12  keyValue2 [KeyValueWidget2]
      c 0 w12  containerTitle3 [TextWidget2]   (not in a pane)

### container4   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [4f067]
      c 0 w12  table1 [TableWidget2]
      c 0 w12  containerTitle4 [TextWidget2]   (not in a pane)

### container5   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [4f067]
      c 0 w12  table2 [TableWidget2]
      c 0 w12  containerTitle5 [TextWidget2]   (not in a pane)

### container6   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [4f067]
      c 0 w12  table3 [TableWidget2]
      c 0 w12  containerTitle6 [TextWidget2]   (not in a pane)

### container7   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer1)
  - "View 1"  [4f067]
      c 0 w12  table4 [TableWidget2]
      c 0 w12  containerTitle7 [TextWidget2]   (not in a pane)

### collapsibleContainer1   [ContainerWidget2] — 1 pane(s)
  - "View 1"  [74c3d]
      c 0 w 5  chatContentSearch [TextInputWidget2] "Search Content"
      c 6 w 6  text5 [TextWidget2]
      c 0 w 5  chatUserSearch [TextInputWidget2] "Search Username"
      c 0 w 5  chatIdSearch [TextInputWidget2] "Search ChatId"
      c 6 w 6  text6 [TextWidget2]
      c 6 w 6  table7 [TableWidget2]
      c 6 w 6  banReason [TextInputWidget2] "Ban Reason (as retool note)"
      c 6 w 6  banButton [ButtonWidget2] "Ban and Set Note"
      c 0 w 9  collapsibleTitle1 [TextWidget2]   (not in a pane)
      c 9 w 3  collapsibleToggle1 [ToggleButtonWidget] "{{ self.value ? 'Hide' : 'Show' }}"   (not in a pane)

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

# bulk-ban.json

queries: 15   components: 12
resources: REST-WithoutResource, JavascriptQuery, Replicated_Read_Prod, retool_db, Clickhouse, Clickhouse - protection disabled, Prod

## component types (scale signal; the structure itself is below)
  TextAreaWidget: 3
  TextWidget2: 3
  ButtonWidget2: 2
  Frame: 1
  Function: 1
  TableWidget2: 1
  SelectWidget2: 1

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

## queries

### BANAPI   [RESTQuery / REST-WithoutResource] 
    depends on: userId, retoolContext.configVars.WEBHOOK_TOKEN, reasonCode
    https://www.civitai.com/api/mod/ban-user?userId={{userId}}&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}&reasonCode={{ reasonCode }}

### BanUsers   [JavascriptQuery / JavascriptQuery] 
    const userIds = textArea1.value.split('\n');
    
    let i = 0;
    let retryCounter = 0;
    
    TriggerQuery(i);
    
    function TriggerQuery(i) {
      if (i === userIds.length) {
        ListUsers.trigger();
        LogBans.trigger();
        return
      }
    
      if(retryCounter >= 5){
        return
      }
    
      BANAPI.trigger({
        additionalScope: { 
          userId: userIds[i],
          reasonCode: banReason.value
        },
        onSuccess: function() {
          retryCounter = 0
          TriggerQuery(i + 1);
        },
        onFailure: function () {
          retryCounter++
          TriggerQuery(i)
        }
      });
    }

### ListUsers   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea1.value.split('\n')
    SELECT "id", "bannedAt" FROM "User" 
    WHERE "id" = ANY({{textArea1.value.split('\n')}})
    AND "bannedAt" IS NULL
    AND "deletedAt" IS NULL

### LogBans   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### GetUsers   [SqlQuery / Clickhouse] 
    SELECT DISTINCT "fromAccountId" 
    FROM "default"."buzzTransactions" 
    WHERE amount >= 50
    AND "toAccountId" IN(4059236, 5561675, 5603046, 5601367, 5551054)
    AND "type" = 'tip' 
    AND "fromAccountId" > 5400000
    ORDER BY 1 DESC

### GetIP   [SqlQuery / Clickhouse - protection disabled] 
    depends on: GetUsers.data.fromAccountId
    select COUNT(*), "ip" FROM "default"."userActivities" where "targetUserId" IN({{GetUsers.data.fromAccountId}}) and "type" = 'Registration' group by "ip" order by 1 desc

### GetEmail   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: GetUsers.data.fromAccountId
    SELECT
        substring(email from '@(.+)$') AS domain,
        count(*) AS count_of_emails
    FROM
        "User"
    WHERE
        id = ANY({{GetUsers.data.fromAccountId}})
    GROUP BY
        domain
    order by 2 desc

### query15   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT *
    FROM "User"
    WHERE substring(email from '@(.+)$') = '%@<REDACTED_DOMAIN>%'
    AND "bannedAt" IS NULL

### query13   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea2.value.split(', ')
    select username, substring(email from '@(.+)$') AS domain from "User" where "username" = ANY({{textArea2.value.split(', ')}})

### UserNotes   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: UserNotes

### UsersByIp   [SqlQuery / Clickhouse] 
    SELECT DISTINCT targetUserId 
    FROM default.userActivities 
    WHERE ip IN('203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4')
    AND type = 'Registration'
    ORDER BY 1

### query12   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea2.value.split('\n')
    select id from "User" where username = ANY({{ textArea2.value.split('\n') }})
    and "bannedAt" IS NULL

### deleteComments   [SqlQueryUnified / Prod] 
    depends on: query22.data.id
    delete from "CommentV2" where "id" = ANY({{ query22.data.id }})

### getEmails   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea1.value.split('\n')
    SELECT email FROM "User" WHERE id = ANY({{ textArea1.value.split('\n') }})

### query16   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textArea1.value.split('\n')
    select username from "User" where id = anY({{ textArea1.value.split('\n') }})

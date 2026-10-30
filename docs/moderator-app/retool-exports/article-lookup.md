# article-lookup.json

queries: 3   components: 9
resources: Replicated_Read_Prod, Clickhouse

## component types (scale signal; the structure itself is below)
  TableWidget2: 2
  TextWidget2: 2
  Screen: 1
  Frame: 1
  ContainerWidget2: 1
  TabsWidget2: 1
  TextInputWidget2: 1

## tabs & option sets — READ THESE, they are functionality
  Tab labels are the app's table of contents; dropdown options are canned workflows that
  exist in no query. A tab you did not port is a capability you did not port.

### tabbedContainer1   [ContainerWidget2]
    - Article Info

### tabs1   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

### tabbedContainer1   [ContainerWidget2] — 1 pane(s), tab bar tabs1
  - "Article Info"  [00030]
      c 0 w 9  textInput1 [TextInputWidget2] "Article Id"
      c 0 w 4  text2 [TextWidget2]
      c 0 w12  table1 [TableWidget2]
      c 0 w 4  text1 [TextWidget2]
      c 0 w12  table2 [TableWidget2]
      c 0 w12  tabs1 [TabsWidget2]   (not in a pane)

## queries

### FindArticle   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textInput1.value
    SELECT * FROM "Article"
    WHERE id = {{ textInput1.value }}

### ArticleMetrics   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: textInput1.value
    SELECT * FROM "ArticleMetric"
    WHERE "articleId" = {{ textInput1.value }}

### query1   [SqlQuery / Clickhouse] 
    -- Table schema
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'your_table';
    
    -- All tables + columns in a schema
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;

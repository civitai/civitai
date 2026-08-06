# Article Lookup.json

queries: 3   components: 9
resources: Replicated_Read_Prod, Clickhouse

## component types (layout is NOT ported — this is only a scale signal)
  TableWidget2: 2
  TextWidget2: 2
  Screen: 1
  Frame: 1
  ContainerWidget2: 1
  TabsWidget2: 1
  TextInputWidget2: 1

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

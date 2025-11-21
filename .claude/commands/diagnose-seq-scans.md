---
description: Remedy high seq scans on a table
argument-hint: "[table name]"
---

Your goal is to diagnose why there are high volumes of seq scans in a postgres database. You'll be using the postgres MCP to interact with a read replica of a postgres database.

## Workflow
1. To prepare, use context7 to review documentation about views, joins, indexes, seq scans, and available diagnostic and stat tables/queries in postgres 17.
2. Review the structure of the target table: $ARGUMENTS
3. Review existing indexes and their usage (query 3 times with 60 seconds between each query to identify the rate of change in their usage)
4. Review top queries that are utilizing the target table (query 3 times with 30 seconds between each query to identify the rate of change in their call rate)
5. Review all views that are utilizing the target table
6. Review top queries for those views (query 3 times with 30 seconds between each query to identify the rate of change in their call rate)
7. Explain to the user how the table is being used most based on your review and if there are simple indexes or additional cover that needs to be added to indexes suggest it
8. Wait for additional direction from the user

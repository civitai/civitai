---
name: postgres-query
description: Run PostgreSQL queries for testing, debugging, and performance analysis. Use when you need to query the database directly, run EXPLAIN ANALYZE, compare query results, or test SQL optimizations. Always uses read-only connections unless explicitly directed otherwise.
allowed-tools: Read, Write, Bash, Glob, Grep
---

# PostgreSQL Query Testing

Use this skill to run ad-hoc PostgreSQL queries for testing, debugging, and performance analysis.

## Connection Configuration

The project has multiple database connections configured in `.env`:

- `DATABASE_REPLICA_URL` - **Read-only replica** (USE THIS BY DEFAULT)
- `DATABASE_URL` - Primary database (writable - only use when explicitly requested)

**IMPORTANT**: Always use `DATABASE_REPLICA_URL` for queries unless the user explicitly requests write access or needs to test against the primary.

## Creating a Query Test Script

Create a `.mjs` file in the project root for running queries:

```javascript
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pg;

// USE READ REPLICA BY DEFAULT
const client = new Client({
  connectionString: process.env.DATABASE_REPLICA_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  console.log('Connected to database (read replica)\n');

  // Run your queries here
  const result = await client.query(`
    SELECT * FROM "User" LIMIT 5
  `);

  console.log('Results:', result.rows);

  await client.end();
}

main().catch(console.error);
```

Run with:
```bash
node your-script.mjs
```

## Common Query Patterns

### EXPLAIN ANALYZE for Performance Testing

```javascript
async function runExplain(name, query) {
  console.log(`\nEXPLAIN: ${name}`);
  console.log('='.repeat(60));
  const result = await client.query(`EXPLAIN ANALYZE ${query}`);
  console.log(result.rows.map(r => r['QUERY PLAN']).join('\n'));
}

// Usage
await runExplain('My Query', `
  SELECT * FROM "User" WHERE id = 123
`);
```

### Comparing Two Query Approaches

```javascript
async function compareQueries(name1, query1, name2, query2) {
  // Run first query
  const start1 = Date.now();
  const result1 = await client.query(query1);
  const time1 = Date.now() - start1;

  // Run second query
  const start2 = Date.now();
  const result2 = await client.query(query2);
  const time2 = Date.now() - start2;

  // Compare results
  const set1 = new Set(result1.rows.map(r => JSON.stringify(r)));
  const set2 = new Set(result2.rows.map(r => JSON.stringify(r)));
  const match = set1.size === set2.size &&
    [...set1].every(item => set2.has(item));

  console.log(`${name1}: ${result1.rows.length} rows in ${time1}ms`);
  console.log(`${name2}: ${result2.rows.length} rows in ${time2}ms`);
  console.log(`Results match: ${match ? '✓ YES' : '✗ NO'}`);
  console.log(`Speedup: ${(time1 / time2).toFixed(1)}x`);

  return { match, time1, time2 };
}
```

### Parameterized Queries (Safe from SQL Injection)

```javascript
// Use parameterized queries for user-provided values
const userId = 123;
const result = await client.query(
  'SELECT * FROM "User" WHERE id = $1',
  [userId]
);

// For dates
const cutoffDate = new Date();
cutoffDate.setMonth(cutoffDate.getMonth() - 1);
const result = await client.query(
  'SELECT * FROM "Purchase" WHERE "createdAt" > $1',
  [cutoffDate]
);
```

### Checking Index Usage

```javascript
// Verify an index is being used
const explainResult = await client.query(`
  EXPLAIN ANALYZE
  SELECT * FROM "Account"
  WHERE provider = 'discord'
  AND metadata -> 'roles' @> '["Supporter"]'
`);

// Look for "Index Scan" or "Bitmap Index Scan" in the output
const plan = explainResult.rows.map(r => r['QUERY PLAN']).join('\n');
const usesIndex = plan.includes('Index Scan') || plan.includes('Bitmap Index Scan');
console.log(`Uses index: ${usesIndex ? '✓ YES' : '✗ NO (sequential scan)'}`);
```

## Cleanup

Always delete test scripts after use:

```bash
rm your-test-script.mjs
```

## When to Use Write Access

Only use `DATABASE_URL` (primary/writable) when:
1. The user explicitly requests it
2. You need to test write operations
3. You're verifying transaction behavior

To use write access, change the connection:
```javascript
const client = new Client({
  connectionString: process.env.DATABASE_URL,  // PRIMARY - WRITABLE
  ssl: { rejectUnauthorized: false }
});
```

## Reference

- PostgreSQL documentation: https://www.postgresql.org/docs/
- EXPLAIN documentation: https://www.postgresql.org/docs/current/sql-explain.html
- Index types: https://www.postgresql.org/docs/current/indexes-types.html

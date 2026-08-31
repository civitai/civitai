import { sql } from 'kysely';

// Nested-read helpers. Kysely's Postgres helpers build correlated `jsonb_agg`/`to_jsonb` subqueries whose
// result types are INFERRED from the subquery — the Kysely equivalent of a Prisma `include`, with the return
// type derived automatically (no hand-authored selector/GetPayload type). Postgres (node-postgres) parses the
// jsonb result to JS objects on its own, so no result-parsing plugin is needed. Note: dates/bigints inside the
// nested json come back as STRINGS (JSON serialization) — parse per-field where a Date/bigint is needed.
export { jsonArrayFrom, jsonObjectFrom, jsonBuildObject } from 'kysely/helpers/postgres';

// Write helper for jsonb columns. node-postgres serializes a plain OBJECT parameter to jsonb via JSON.stringify
// (fine), but serializes a JS ARRAY as a Postgres array literal (`{1,2}`) — wrong for a jsonb column. Wrap
// every jsonb-column write in toJson() so both objects and arrays serialize correctly and unambiguously.
export function toJson<T>(value: T) {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

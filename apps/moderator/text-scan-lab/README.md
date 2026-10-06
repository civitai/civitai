# Text-scan prompt lab

Prompt drafts, test sets and test runs for the text-scan prompt lab, in the **moderator** database.
Nothing here changes a live prompt until a draft is published.

| table | holds |
| --- | --- |
| `text_scan_prompt_draft` | a draft's changed prompts only; unchanged keys run the active prompt |
| `text_scan_test_set` | a named set of test cases |
| `text_scan_test_case` | a text snapshot and what each label is expected to return |
| `text_scan_test_run` | one run of a set against active or a draft, and exactly which prompts ran |
| `text_scan_test_result` | one case's output in one run; scored on read against the case's current expectation |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**, with `psql` against
   `MODERATOR_DATABASE_URL`. It is idempotent.

   ```bash
   psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/moderator/text-scan-lab/schema.sql
   ```

2. From the repo root, run `pnpm run db:moderator:pull && pnpm run db:moderator:generate`. The diff
   should be empty: the five models in `schema.prisma` and their types in
   `src/lib/server/moderator-db/types.ts` were generated from this SQL.

## Test cases

A case snapshots its text (`fields`) when it is added, so a run scores the same text every time.
When the source entity or its author's account is deleted, `fields` is set to null and
`source_deleted_at` is stamped; the case keeps its expectations and its past results.

## Purge

Clears the text of entity cases whose source row is gone or soft-deleted, or whose author's account is
deleted. Free-text and synthetic cases are never touched. Opening a set's page, quoting a run and
starting one purge that set first; this command purges every set, and prints counts only.

**Run it weekly** (an operator task: the spoke has no scheduler). It is idempotent.

```bash
pnpm --filter @civitai/moderator-app exec tsx --env-file=.env text-scan-lab/purge.ts [--set <id>]
```

It reads `MODERATOR_DATABASE_URL` and `DATABASE_REPLICA_URL` (main database, read only).

## Import

Seeds a test set from a local JSON file. Keep the file local (`*.local.*`); never commit it.

```bash
pnpm --filter @civitai/moderator-app exec tsx text-scan-lab/import.ts --file <path.json> --set "<name>" --by <moderatorId> [--dry-run]
```

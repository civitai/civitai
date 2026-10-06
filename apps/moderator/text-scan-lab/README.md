# Text-scan prompt lab

Prompt drafts, test sets and test runs for the text-scan prompt lab, in the **moderator** database.
Nothing here changes a live prompt until a draft is published.

| table                    | holds                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_scan_prompt_draft` | a draft's changed prompts only; unchanged keys run the active prompt. `kind` is `working` (a moderator's unnamed, auto-saved changes, at most one each) or `proposed` (named, shared)                                                                                                                           |
| `text_scan_test_set`     | a named set of test cases                                                                                                                                                                                                                                                                                       |
| `text_scan_test_case`    | a text snapshot and what each label is expected to return; `source_ids` holds every message of a ChatMessage window                                                                                                                                                                                             |
| `text_scan_test_run`     | one run of a set against active or a draft, and exactly which prompts ran. The scan runs after the request that started it: `scan_total`, `scan_done` and `progress_at` track it (a running run with a stale `progress_at` was interrupted), and `scan_seconds` is the time spent scanning, summed over re-runs |
| `text_scan_test_result`  | one case's output in one run; scored on read against the case's current expectation                                                                                                                                                                                                                             |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**, with `psql` against
   `MODERATOR_DATABASE_URL`. It is idempotent. It also adds the `kind`, `source_ids` and run-progress
   columns to existing tables, so re-apply it on a database that predates them.

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
deleted, and nulls the stored outputs of those cases' results. Free-text cases are never touched. A
ChatMessage case keeps the ids of every message in its window (`source_ids`) and is wiped when any of
them is gone, soft-deleted or by a deleted account.

The lab also purges a set whenever it is opened, its cases are listed, one of its cases is checked or
it is run, so a deleted
source never shows there. **Run it weekly** anyway (the spoke has no scheduler), for sets nobody
opens.

```bash
pnpm --filter @civitai/moderator-app exec tsx --env-file=.env text-scan-lab/purge.ts [--set <id>]
```

It reads `MODERATOR_DATABASE_URL` and `DATABASE_REPLICA_URL` (main database, read only).

## Import

Seeds a **new** test set from a local JSON file. Keep the file local (`*.local.*`); never commit it.

```bash
CIVITAI_API_KEY=<your own full-scope API key> pnpm --filter @civitai/moderator-app exec \
  tsx --env-file=.env text-scan-lab/import.ts --file <path.json> --set "<name>" --by <moderatorId> [--dry-run]
```

```json
{
  "cases": [
    {
      "entityType": "Model",
      "entityId": 123,
      "expected": { "nsfw": { "min": "none", "max": "pg13" }, "poi": false }
    },
    {
      "entityType": "Comment",
      "fields": [{ "heading": "Comment", "text": "..." }],
      "expected": { "scam": true },
      "synthetic": true,
      "note": "..."
    }
  ]
}
```

- An entity case without `fields` snapshots the text the main app composes for it now; ids it
  cannot compose (not found, too short) are skipped and counted. An entity case with `fields` (and
  optionally `authorId`) imports a snapshot composed earlier as-is. A free-text case uses its `fields`.
- `expected` takes the labels the entity type scores; leave a label out to not score it.
- The whole file is validated first, and the set and its cases are written in one transaction.
  An existing set name is refused.
- It reads `MODERATOR_DATABASE_URL` and `CIVITAI_APP_URL` from `.env` and prints both targets before
  it calls or writes anything. Always run it with `--dry-run` first and check that `moderatorDb` is
  the database you mean. Entity cases without `fields` call `/api/mod/text-scan` (`composeEntities`)
  with `CIVITAI_API_KEY`, the running moderator's own key, which **must be full-scope**: that action
  refuses any other key with 403. Composing text bills nothing. It prints counts only.

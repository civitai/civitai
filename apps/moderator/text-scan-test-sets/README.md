# Text-scan test sets

Saved lab texts with the verdict a moderator expects, and runs that score the production prompts
(baseline) and a draft against them. Behaviour: `docs/features/text-scan.md`. Nothing here changes a
scan, a prompt or a rule.

| piece | where |
| --- | --- |
| tables | `schema.sql`, in the **moderator** database |
| sets and cases | `src/lib/server/text-scan-tests/store.ts` |
| run worker | `src/lib/server/text-scan-tests/worker.ts` |
| pages | the Test sets tab on `/text-scan/prompts` and `/text-scan/model-rules`; `/text-scan/test-sets/<id>` |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**. It is idempotent.
2. Run `pnpm run db:moderator:pull`, then `pnpm run db:moderator:generate`. The diff should be empty:
   the models in `prisma/schema.prisma` were written to match this SQL.
3. On `/admin`, grant `textScan.testSets.edit` to whoever curates sets. Viewing and running sets needs
   only the Prompts or Model rules page grant.

## CLIs

Both print counts only (entity type, label, refusal reason), never text, ids, keys or set names. Run from
the repo root with `pnpm exec tsx --env-file=.env <script>`. Keep seed files out of the repo.

| script | what it does | env |
| --- | --- | --- |
| `import.ts` | Seeds a set from a `lab-seed` or `bench` JSON file. Dry run unless `--write`. Idempotent on the entity or `key`. Goes through `upsertCase`, so a refused row is counted, not printed. | `MODERATOR_DATABASE_URL` |
| `purge.ts` | Wipes text and stored verdicts of cases whose source entity or author was deleted (including imported rows with an author id only), and drops expired draft-run results. Run it by hand, weekly. | `MODERATOR_DATABASE_URL`, `DATABASE_REPLICA_URL` (read only) |

```bash
pnpm exec tsx --env-file=.env apps/moderator/text-scan-test-sets/import.ts \
  --set <name> --workspace prompts|modelRules --file <path> --format lab-seed|bench \
  [--label poi|minor|scam --truth-map <value>=yes|no|skip,...] --by <moderatorId> [--write]
```

`--truth-map` maps the bench file's truth values to `yes`, `no` or `skip`; the CLIs hold no dataset vocabulary.

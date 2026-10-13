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

# Text-scan test sets

Saved lab texts with the verdict a moderator expects, and runs that score the production prompts
(baseline) and a draft against them. Behaviour: `docs/features/text-scan.md`. Nothing here changes a
scan, a prompt or a rule.

| piece | where |
| --- | --- |
| tables | `schema.sql`, in the **moderator** database |
| sets and cases | `src/lib/server/text-scan-tests/store.ts` |
| run worker | `src/lib/server/text-scan-tests/worker.ts` |
| pages | the Test sets tab on `/text-scan/prompts`; `/text-scan/test-sets/<id>` |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**. It is idempotent.
2. Run `pnpm run db:moderator:pull`, then `pnpm run db:moderator:generate`. The diff should be empty:
   the models in `prisma/schema.prisma` were written to match this SQL.
3. On `/admin`, grant `textScan.testSets.edit` to whoever curates sets or cancels another moderator's
   run. Viewing and running sets needs only the Prompts page grant.

`schema.sql` adds a partial unique index for free-text cases (`text_scan_test_case_free_text_key`). It
must exist **before** the code deploys: free-text capture's `ON CONFLICT` targets it. The index build
fails if duplicate free-text rows already exist, so check for duplicates first. Prisma 6.13 cannot
express a partial index, so after `db:moderator:pull` the schema may need a hand check.

## How a run works

- **Quote, then confirm.** The Test sets tab prices the run first (`quoteTexts` on a sample of up to 8
  cases; 1 Buzz per call as the fallback price) and shows calls, Buzz and minutes. A call is one case
  scanned, so Buzz and calls scale with cases, not with requests. Start is refused if the set, the draft or the live
  prompts changed since the quote. Buzz is derived on the server, not taken from the form.
- **Baseline and draft.** A run of a draft is compared with the set's baseline: its latest finished run
  of the production prompt versions. A fresh baseline is
  reused, so only the draft side is scanned; a stale or missing one is queued alongside. A fresh
  baseline missing some cases (added since, or re-added with changed text, which drops that case's
  verdicts) is topped up in place; if the top-up is cancelled or fails, the baseline is done again at
  its old finish time. A draft run never becomes a baseline.
- **Background worker.** Runs scan in the moderator server after the request returns, up to 8 cases per
  harness request (one request covers up to 8 calls, so a small set finishes in one step and progress jumps),
  writing each chunk's results as it lands. Harness calls use the starting moderator's
  session. A database lease makes sure one process scans a run. A run whose heartbeat is older than
  5 minutes is resumed when a moderator opens a Test sets view (under that viewer's session); on boot
  the server only releases this host's stale leases. A restart re-scans at most the chunk in flight.
- **Limits.** At most 500 cases per run, one run in progress per moderator, three in total.
- **Errors** are recorded per case and never scored as misses; **Re-run errors** repeats only those,
  with the run's recorded prompts. It is refused once a prompt it used has a newer version, for an
  expired draft, and for a stopped run that still has cases it never scanned (start a new run).
- **Wiped cases.** A case whose source was deleted loses its text and verdicts; its results count as
  missing, never as a failure.
- **Audit.** Run start, cancel and re-run each write a `ModActivity` row for the set and an Axiom event
  (run ids, calls, server-derived Buzz); never text. Adding, relabelling and removing a case, and
  creating or archiving a set, also write a `ModActivity` row.
- **Access.** Running needs only the workspace page grant. Curating sets and cancelling another
  moderator's run need `textScan.testSets.edit`.

## CLIs

Both print counts only (entity type, label, refusal reason), never text, ids, keys or set names. Run from
the repo root with `pnpm exec tsx --env-file=.env <script>`. Keep seed files out of the repo.

| script | what it does | env |
| --- | --- | --- |
| `import.ts` | Seeds a set from a `lab-seed` or `bench` JSON file. Dry run unless `--write`. Idempotent on the entity or `key`; a re-import that changes cases rescores the set's runs. Goes through `upsertCase`, one savepoint per row: a row refused by validation (400) or as a conflicting case (409) is counted and skipped and the rest land; any other error rolls back the whole import. | `MODERATOR_DATABASE_URL` |
| `purge.ts` | Wipes text and stored verdicts of cases whose source entity or author was deleted (including imported rows with an author id only), and drops expired draft-run results. Dry run unless `--write`; prints both databases it reads and the counts it would wipe. Run it by hand; the app has no scheduler. | `MODERATOR_DATABASE_URL`, `DATABASE_REPLICA_URL` (read only) |

```bash
pnpm exec tsx --env-file=.env apps/moderator/text-scan-test-sets/import.ts \
  --set <name> --workspace prompts --file <path> --format lab-seed|bench \
  [--label poi|minor|scam --truth-map <value>=yes|no|skip,...] --by <moderatorId> [--write]
```

`--truth-map` maps the bench file's truth values to `yes`, `no` or `skip`; the CLIs hold no dataset vocabulary.

| file format | shape |
| --- | --- |
| `lab-seed` | `{ cases: [{ entityType, entityId?, authorId?, fields, expected, note? }] }` (`entityId` and `authorId` may be `null`); nsfw ranges kept |
| `bench` | `[{ key, entityType, fields, truth, entityId? }]`; `key` is the case's import key; `truth` goes through `--truth-map` onto `--label` (required for `bench`) |

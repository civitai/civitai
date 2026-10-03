# Removal-label pilot: relabel set and eval report

Offline eval for the removal-label check. Four questions about an image (minor present, sexual
level, violence, school setting) are composed in code into a proposed label, which is compared with
what enforcement did. Nothing here changes a removal, a hold or a label in production.

The pieces:

| piece | where |
| --- | --- |
| question options, composer, disagreement rules | `src/lib/removal-label/` |
| tables | `schema.sql`, in the **moderator** database |
| blind relabel page | `/audit/relabel` |
| batch builder | `src/lib/server/relabel-batch-build.ts`; `build-set.ts` is a CLI over it |
| report | `report.ts` |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**. It is idempotent. Nothing runs it
   automatically.
2. Run `pnpm run db:moderator:pull` and then `pnpm run db:moderator:generate`. The diff should be
   empty: the models in `schema.prisma` were written to match this SQL before it existed anywhere.
3. On `/admin`, grant `/audit/relabel` to the two labelers. Until then only `moderator:admin` can
   open it.
4. Set `RELABEL_NOT_REMOVED_BANDS` on the moderator app. Batches then build daily (below).

## Two strata, and why removed items are drawn daily

- **removed**: moderator `DeleteTOS` removals in the four minor buckets, taken from ClickHouse.
- **not_removed**: recently scanned images that passed, sampled across bands of the scanner's minor
  score and NSFW level. This is the other direction: what enforcement let through that the model
  would flag.

A removed image is hard-deleted 7 days after the block (`remove-blocked-images`). So removed items
are sampled from the last few days, each carries `purge_after`, and the page stops serving an item
once that time has passed. Labels and model predictions must land before it. Retention is not
changed for this pilot. Not-removed items have no deadline.

Anything a CSAM report or block touches is excluded from both strata
(`src/lib/server/relabel-csam-exclusion.ts`): an image listed in a `CsamReport` or carrying a user
CSAM report, and every image of an owner with a `CsamReport`, a CSAM report against the user, or any
CSAM-blocked image. The check runs again each time an item is served. The scanner's CSAM output is never
read and is never model input: `signal-state.ts` builds model state from an allowlist.

## Blinding

A labeler sees the image and nothing else: no image id, stratum, removal reason, NSFW level or the
other labeler's answer. The page addresses items by a random token, never the serial id, which grows
batch by batch and with the purge window would give the stratum away. Each labeler gets the items in
a different fixed order. A database trigger caps each item at two labelers. An image is in the set
at most once: a labeler batch that samples a model-only image promotes that row.

## The daily batch

The main app's `relabel-build-batch` job calls the spoke's `relabel-build-batch` mod-action once a
day. The batch is named by the UTC date, and its caps (100 removed, 40 not removed) bound what the
batch holds, so a second run that day adds nothing and a run after a failed one finishes it. Its
counts are logged as `relabel-build-batch`.

The not-removed bands come from `RELABEL_NOT_REMOVED_BANDS` (comma-separated edges) in the moderator
app's environment. Unset, the batch holds removed items only.

The mod-action takes `dryRun: true` to report what it would pick without writing.

## Running by hand

```bash
# dry run: prints per-stratum counts, writes nothing
pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/build-set.ts \
  --batch 2026-10-06 --removed 100 --not-removed 40 --bands <edges>

# then the same with --write

# items for the model arms only, never shown to labelers (full-population numbers)
... --model-only --removed 5000 --not-removed 0 --write
```

`--bands` are the scanner-score edges for the not-removed stratum. Pass them at run time and keep
them out of the repo. Without them the batch holds removed items only. `--removed` and
`--not-removed` cap the batch, as above. `MODERATOR_DATABASE_URL` needs `?sslmode=no-verify` for the cluster.

The eval harness writes one `relabel_prediction` row per item per arm (`image`, `image_signals`,
`signals`). `answers` holds each question's `{ choice, confidence, abstained }`. The report then
runs:

```bash
pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/report.ts \
  --run <run_id> --thresholds <private.json> [--rows-out <private.jsonl>]
```

The thresholds file is `{ "minorPresent": n, "sexualLevel": n, "violence": n, "schoolSetting": n }`
and stays private. The printed report contains counts only. `--rows-out` writes one row per item per
arm, with image ids, for the rule-set comparison view, so write it somewhere private.

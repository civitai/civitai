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
| batch builder | `build-set.ts` |
| report | `report.ts` |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**. It is idempotent. Nothing runs it
   automatically.
2. Run `pnpm run db:moderator:pull` and then `pnpm run db:moderator:generate`. The diff should be
   empty: the models in `schema.prisma` were written to match this SQL before it existed anywhere.
3. On `/admin`, grant `/audit/relabel` to the two labelers. Until then only `moderator:admin` can
   open it.
4. Build batches with `build-set.ts` (below).

## Two strata, and why removed items are drawn daily

- **removed**: moderator `DeleteTOS` removals in the four minor buckets, taken from ClickHouse.
- **not_removed**: recently scanned images that passed, sampled across bands of the scanner's minor
  score and NSFW level. This is the other direction: what enforcement let through that the model
  would flag.

A removed image is hard-deleted 7 days after the block (`remove-blocked-images`). So removed items
are sampled from the last few days, each carries `purge_after`, and the page stops serving an item
once that time has passed. Labels and model predictions must land before it. Retention is not
changed for this pilot. Not-removed items have no deadline.

CSAM-reported content is excluded from both strata. That covers any image listed in a `CsamReport`,
and every image of an owner with any report. The scanner's CSAM output is never read and is never
model input: `signal-state.ts` builds model state from an allowlist.

## Blinding

A labeler sees the image and nothing else: no image id, stratum, removal reason, NSFW level or the
other labeler's answer. Each labeler gets the items in a different fixed order. A database trigger
caps each item at two labelers.

## Running

```bash
# dry run: prints per-stratum counts, writes nothing
pnpm exec tsx --env-file=.env apps/moderator/removal-label-eval/build-set.ts \
  --batch 2026-10-06 --removed 100 --not-removed 40 --bands <edges>

# then the same with --write
```

`--bands` are the scanner-score edges for the not-removed stratum. Pass them at run time and keep
them out of the repo. `MODERATOR_DATABASE_URL` needs `?sslmode=no-verify` for the cluster.

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

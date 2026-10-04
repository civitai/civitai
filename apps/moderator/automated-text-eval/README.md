# Automated text relabel

A blind, human-labelled sample of Clavata "Automated" report hits, to measure how often each Clavata
tag is right and to serve as gold for a later decision-model eval. Nothing here changes a report, a
moderation decision or Clavata.

| piece | where |
| --- | --- |
| tables | `schema.sql`, in the **moderator** database |
| sampling and copy | `src/lib/server/text-relabel-snapshot.ts`; `snapshot.ts` is a CLI over it |
| labelling page | `/audit/text-relabel` |
| answers and hand-off tags | `src/lib/automated-text/` |

## Apply order

1. Apply `schema.sql` to the moderator database **by hand**. It is idempotent.
2. Run `pnpm run db:moderator:pull`, then `pnpm run db:moderator:generate`. The diff should be empty:
   the models in `schema.prisma` were written to match this SQL.
3. On `/admin`, grant `/audit/text-relabel` to the labeller. Until then only `moderator:admin` can
   open it.
4. Run the snapshot (below), dry run first.

## The snapshot

`clear-automated-reports` deletes a report's text 14 days after Clavata flagged it. The snapshot
copies a pool of (report, tag) pairs from the replica into `text_relabel_item` before that happens.

- **Unit:** a (report, tag) pair. A report flagged with three tags can be up to three items, each
  judged against one tag, so precision comes out per tag.
- **Pool:** every CSAM pair in the window, plus up to a fixed number per other tag (`POOL_QUOTAS`).
- **Wave 1:** the first 205 to label (`WAVE_ONE_QUOTAS`). The page serves all of wave 1 before any of
  wave 2.
- **Strata:** within a tag, picks are spread evenly over Clavata confidence band and public vs
  private (chat), and each item records its stratum's population so totals can be re-weighted.
- **Draw:** seeded. The same seed over the same window draws the same pairs.
- **Re-runs** keep the first copy of a pair, its wave and its text.

```bash
# dry run: per-tag and per-stratum counts, writes nothing
pnpm exec tsx --env-file=.env apps/moderator/automated-text-eval/snapshot.ts --batch <date> --seed <seed>

# then the same with --write; --purge-days sets purge_after (default 90)
```

It needs `DATABASE_REPLICA_URL` and `MODERATOR_DATABASE_URL` (with `?sslmode=no-verify` for the cluster).

🔴 **The CLI prints counts only.** The text moves replica to moderator database inside the process. A
database error is printed by its code and constraint, never its message, because Postgres quotes the
failing row. Do not add logging of rows, and do not read `text_value` into an agent session or any
hosted model: query counts and ids only.

## Purge

`purge_after` is set at copy time. The page stops serving an item once it has passed, but nothing
clears the text on a schedule. Run:

```bash
pnpm exec tsx --env-file=.env apps/moderator/automated-text-eval/snapshot.ts --purge
```

It sets `text_value` to null and keeps the row and its answers, so the counts survive the text.

## Blinding

The labeller sees the text, the one tag and the kind of content (comment, chat, model…). Not
Clavata's confidence, the stratum, the wave, the report or author id, or another labeller's answer.
Items are addressed by a random token, and each labeller walks them in a different fixed order. A
database trigger caps each item at two labellers, so a second labeller can be added later for an
agreement number.

## Hand-off

A `clear_violation` on a CSAM or Grooming item is a case, not only a label. After saving one, the
page links to the Automated report's own action view (`/reports/<type>?report=<id>`, which opens a
single report whatever its status), to the content, and to the author in User Lookup, which shows
their CSAM reports and account actions. The page lists every such answer of the labeller's, so a case
is still one click away after the queue moves on.

# Merging duplicate version tags

Ten tag pairs are the same model version spelled two ways — a decimal comma against a decimal dot
(`sdxl 1,0` and `sdxl 1.0`). Each pair is two indexable tag pages splitting one set of models, so
the merge is an SEO fix as much as a data cleanup.

The pairs, their row counts and the merge direction are in the `tag-display-names.xlsx` workbook,
sheet **Comma renames** — kept outside this repo, since it lists production tag names and counts.

## What already does the work

Nothing needs to be written or deployed for the bulk of it. A `Replace` rule on `TagsOnTags` plus the
existing `apply-tag-rules` job (`src/server/jobs/apply-tag-rules.ts`, every 5 minutes) copies rows
onto the keeper with `ON CONFLICT DO NOTHING`, then deletes the loser's. `/moderator/tags` creates
those rules.

**The rule's direction reads backwards:** `fromTag` is the **keeper** that receives the rows,
`toTag` is the tag that gets **emptied**. Confirm it on one 0-model pair before doing the rest.

The job covers `TagsOnModels`, `TagsOnPost`, `TagsOnArticle` and `TagsOnCollection` — 541 of the 557
rows that move. It busts `modelVotableTagsCache` for the models it touches.

It does **not** cover:

| left over | rows | what to do |
| --- | --- | --- |
| `TagsOnImageVote` | 10 | every one collides with an existing vote — delete, don't move |
| `TagEngagement` | 3 | move by hand |
| `TagsOnBounty` | 3 | move by hand |
| `TagMetric`, `TagRank` | per tag | derived — delete the loser's rows, let the metric jobs recompute |

It also never deletes the loser `Tag` row. `appendTag` takes a `maxImageId` and never uses it, so
image tags (`TagsOnImageNew`) are untouched — irrelevant here (0 rows), but don't assume it covers
images for a future merge.

Views need nothing: `ImageTag`, `ModelTag`, `PostTag`, `TagsOnImageDetails`, `TagStat`, `TagRank_Live`.

## Two shapes of merge

**Eight pairs keep the dot tag.** The dot spelling is already the bigger tag, so it is the keeper and
nothing is renamed. The comma tag stays as an emptied shell with the `Replace` rule standing, which
is what keeps future uses of the comma spelling merging on their own.

**Two pairs keep the comma tag, then rename it** — `sdxl 1,0` (735 models against the dot tag's 98)
and `wan 2.1 1,3b`. The bigger tag keeps its id, metrics and history, so it wins the merge and is
renamed to the dot spelling afterwards.

🔴 **The rename collides with the emptied loser.** `Tag.name` is unique, so `sdxl 1,0` cannot be
renamed to `sdxl 1.0` while the emptied `sdxl 1.0` row still exists. For these two pairs only, the
loser must be deleted before the rename — which cascades its `Replace` rule away. Optionally
re-create the comma spelling as an empty tag afterwards and point a fresh rule at it, so future
comma uses keep merging.

## Decisions to make first

1. **Keep the emptied tags?** Keeping them (with the rule) is the mechanism working as designed;
   deleting them lets a user re-create the name unmerged. The two rename pairs are the exception
   above.
2. **What the emptied pages do.** They end with 0 models. Setting `unfeatured` on them is enough —
   the tag page already reads it as `deIndex`. A redirect is only worth building for `sdxl 1,0`,
   the one with real traffic.
3. **The one row with no conflict** — `lora officiel darkbrush 0,4`, 0 models. A plain rename or
   leave it; it is not a merge.

## Steps

1. **Snapshot for rollback.** The job's deletes are not reversible. Keep the output of the queries
   in "Queries" below, or `CREATE TABLE ... AS SELECT` copies of the affected rows.
2. **One pair first.** Add the `Replace` rule for `wa2,2` → `wa2.2` (1 model) and confirm after a job
   cycle that rows moved in the direction you expected.
3. **The remaining nine rules**, via `/moderator/tags`.
4. **Verify**: the loser side reads 0 in `TagsOnModels`, `TagsOnPost`, `TagsOnArticle`,
   `TagsOnCollection`.
5. **The 16 leftover rows** by hand — delete the 10 colliding image votes, move the 3 engagements and
   3 bounty rows.
6. **The two renames**, each: delete the emptied loser, then rename the keeper.
7. **Bust the caches** for all 21 names — `getTagWithModelCount`, the tag-page SEO cache, and the
   `getTags` listing (`bustGetTagsCache`).
8. **Resync the search index** for the affected models, or their tag facets stay stale.
9. **Set `unfeatured`** on the emptied tags, and re-run the verification query.

## Queries

Both run read-only against the replica. Substitute the pair list from the spreadsheet.

Rows that will move, per relation, for the losing side:

```sql
WITH losers AS (SELECT "id" FROM "Tag" WHERE "name" IN (/* loser names */))
SELECT 'TagsOnModels' AS relation, count(*) FROM "TagsOnModels" x JOIN losers l ON l.id = x."tagId"
UNION ALL SELECT 'TagsOnPost', count(*) FROM "TagsOnPost" x JOIN losers l ON l.id = x."tagId"
UNION ALL SELECT 'TagsOnArticle', count(*) FROM "TagsOnArticle" x JOIN losers l ON l.id = x."tagId"
UNION ALL SELECT 'TagsOnCollection', count(*) FROM "TagsOnCollection" x JOIN losers l ON l.id = x."tagId"
UNION ALL SELECT 'TagsOnImageVote', count(*) FROM "TagsOnImageVote" x JOIN losers l ON l.id = x."tagId"
UNION ALL SELECT 'TagEngagement', count(*) FROM "TagEngagement" x JOIN losers l ON l.id = x."tagId"
UNION ALL SELECT 'TagsOnBounty', count(*) FROM "TagsOnBounty" x JOIN losers l ON l.id = x."tagId"
ORDER BY 2 DESC;
```

Rows that would collide, so you know what the merge drops rather than moves (models shown; repeat per
relation with its own entity column):

```sql
WITH pairs(loser, winner) AS (VALUES ('2,5d', '2.5d') /* … */)
SELECT count(*)
FROM "TagsOnModels" a
JOIN "Tag" la ON la."id" = a."tagId"
JOIN pairs p ON p.loser = la."name"::text
JOIN "Tag" w ON w."name" = p.winner::citext
JOIN "TagsOnModels" b ON b."tagId" = w."id" AND b."modelId" = a."modelId";
```

Finding the pairs again, if the set needs refreshing:

```sql
SELECT t."name"::text, c."name"::text AS conflict
FROM "Tag" t
LEFT JOIN "Tag" c ON c."name" = replace(t."name"::text, ',', '.')::citext
WHERE t."type" = 'UserGenerated' AND t."name"::text ~ '(?<![0-9])[0-9]{1,2},[0-9]{1,2}(?![0-9])';
```

The digit bounds are what keep `warhammer 40,000` and the anime titles out — a thousands separator is
never a version number.

## Not part of this

`Tag.displayName` (casing for the tag page's title and H1) is separate work, in the same area. It
changes no tag names and does not merge anything.

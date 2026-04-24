# Homepage Featured Collections - Shortlist (tighter filters)

Generated: 2026-04-23T21:41:05.866Z

Source: Postgres read-replica via `postgres-query` skill. Prior candidates list at [`homepage-featured-collections-candidates.md`](./homepage-featured-collections-candidates.md).

## Filters applied

1. `Collection.type = Image` (drops Model/Post/Article collections)
2. `Collection.mode` is NULL or != `Contest` (contests already surface elsewhere)
3. `Collection.read = Public`
4. Excludes `userId = -1` (civitai service user)
5. **Active recently**: >= 5 ACCEPTED `CollectionItem`s created in the last 14 days
6. **Long-lived**: first ACCEPTED item > 90 days old AND ACCEPTED items span >= 3 distinct months
7. Pre-filter to `CollectionMetric.followerCount >= 50` for tractability (no qualifying collection had <50 followers after other filters)
8. Rank by all-time followers DESC

**Sample**: nsfwLevel of the 5 most-recent ACCEPTED images in each collection. Bitwise flags: PG=1, PG13=2, R=4, X=8, XXX=16, Blocked=32. "Safe" column = every sample is only PG/PG13 bits.

## Top 23 Qualified Collections

Only 23 collections passed all 6 filters. Most recently-active `type=Image` non-contest collections skew adult - the high-follower PG art aggregators in the prior list (Outstanding AI-Art, Fantastic AI-Art, The Precious.Art, Artful Beauty) have gone stale and fail filter 5. See the Outstanding/Precious callout below.

| # | Collection | Owner | Followers | Total ACCEPTED | Last-14d | First ACCEPTED | Months | Coll nsfwLevel | Sample (5 most recent) | Safe? |
|--:|:---|:---|--:|--:|--:|:---|--:|:---|:---|:---:|
| 1 | [I ♥️ your pic](https://civitai.com/collections/6473820) | Snilek_Robotka | 1114 | 20934 | 283 | 2024-12-04 | 17 | 29 (PG+R+X+XXX) | 2 PG, 3 PG13 | yes |
| 2 | [Something Special](https://civitai.com/collections/13831379) | Cinnadust | 732 | 3481 | 311 | 2025-11-22 | 6 | 1 (PG) | 4 PG, 1 PG13 | yes |
| 3 | [Beautiful feeling](https://civitai.com/collections/9691988) | vishnarjk | 436 | 4849 | 208 | 2025-05-02 | 12 | 29 (PG+R+X+XXX) | 5 PG | yes |
| 4 | [Best Yuri / Lesbian collection](https://civitai.com/collections/12722945) | martinffm | 390 | 1316 | 36 | 2025-09-18 | 8 | 29 (PG+R+X+XXX) | 2 XXX, 1 X, 2 PG |  |
| 5 | [The Purple List](https://civitai.com/collections/13783073) | purplelady | 358 | 2542 | 177 | 2025-11-19 | 6 | 29 (PG+R+X+XXX) | 1 PG13, 4 PG | yes |
| 6 | [Highly creative](https://civitai.com/collections/5205910) | Daalis | 355 | 2429 | 5 | 2024-10-08 | 19 | 29 (PG+R+X+XXX) | 5 PG | yes |
| 7 | [Pig Pen Club Collection (N)SFW](https://civitai.com/collections/7175002) | Baconbitz | 351 | 4919 | 92 | 2025-01-13 | 16 | 29 (PG+R+X+XXX) | 3 R, 1 PG13, 1 XXX |  |
| 8 | [Futanari Shemale Trans Videos](https://civitai.com/collections/12586788) | animekanno784 | 336 | 2766 | 154 | 2025-09-11 | 8 | 28 (R+X+XXX) | 5 XXX |  |
| 9 | [Small, tiny, petite, doll](https://civitai.com/collections/1080445) | JohnniSalami | 183 | 1926 | 8 | 2024-04-26 | 25 | 29 (PG+R+X+XXX) | 4 XXX, 1 X |  |
| 10 | [Curated Canvas Collection](https://civitai.com/collections/10671501) | TurinBjorn | 172 | 569 | 43 | 2025-06-14 | 6 | 29 (PG+R+X+XXX) | 4 PG, 1 R |  |
| 11 | [Amazing Stuff](https://civitai.com/collections/135926) | hikanthus640 | 155 | 1765 | 51 | 2023-12-16 | 13 | 29 (PG+R+X+XXX) | 1 PG13, 2 X, 1 PG, 1 R |  |
| 12 | [Les Petites](https://civitai.com/collections/7609373) | psyjocky | 100 | 1726 | 92 | 2025-02-03 | 15 | 29 (PG+R+X+XXX) | 4 X, 1 R |  |
| 13 | [Inspiration sold here](https://civitai.com/collections/10575351) | hullahoo | 95 | 743 | 54 | 2025-06-09 | 11 | 29 (PG+R+X+XXX) | 3 XXX, 2 X |  |
| 14 | [Pig Pen's Fantasy Femme Folio](https://civitai.com/collections/10376117) | P_GM | 91 | 1206 | 19 | 2025-05-31 | 12 | 29 (PG+R+X+XXX) | 3 R, 1 PG13, 1 XXX |  |
| 15 | [Beautiful Girls with Monsters](https://civitai.com/collections/11862386) | nofmegan895 | 82 | 1877 | 61 | 2025-08-08 | 9 | 29 (PG+R+X+XXX) | 5 XXX |  |
| 16 | [Breast, Ass, Belly Expansion](https://civitai.com/collections/4996885) | GooLagoon | 69 | 440 | 5 | 2024-09-29 | 20 | 29 (PG+R+X+XXX) | 5 R |  |
| 17 | [Sexy mares! (NSFW, explicit)](https://civitai.com/collections/3028746) | mareschizo | 67 | 21733 | 249 | 2024-07-15 | 22 | 29 (PG+R+X+XXX) | 4 XXX, 1 R |  |
| 18 | [Futanari](https://civitai.com/collections/2745951) | 99MrWilliam99 | 63 | 34445 | 636 | 2024-07-06 | 22 | 29 (PG+R+X+XXX) | 5 XXX |  |
| 19 | [Just Sexy Videos](https://civitai.com/collections/7609291) | psyjocky | 62 | 1564 | 25 | 2025-02-03 | 15 | 29 (PG+R+X+XXX) | 5 X |  |
| 20 | [Sexy Goddes](https://civitai.com/collections/39858) | darthyoudius | 56 | 17239 | 39 | 2023-09-07 | 32 | 29 (PG+R+X+XXX) | 3 X, 2 R |  |
| 21 | [Animated Collection](https://civitai.com/collections/11632784) | HariPjotr | 56 | 551 | 36 | 2025-07-28 | 10 | 29 (PG+R+X+XXX) | 5 XXX |  |
| 22 | [👑 Princess of Nintendo](https://civitai.com/collections/11043205) | canni_ai | 54 | 4652 | 138 | 2025-06-30 | 11 | 29 (PG+R+X+XXX) | 2 X, 1 XXX, 2 R |  |
| 23 | [Olive-toned Beauty in trouble](https://civitai.com/collections/11862422) | nofmegan895 | 50 | 2200 | 152 | 2025-08-08 | 9 | 29 (PG+R+X+XXX) | 1 XXX, 1 X, 3 R |  |

## Safe-content call-outs (sample = all PG/PG13)

- **#1 [I ♥️ your pic](https://civitai.com/collections/6473820)** (Snilek_Robotka) - 1114 followers, 283 items in last 14d, active since 2024-12-04. Sample: 2 PG, 3 PG13.
- **#2 [Something Special](https://civitai.com/collections/13831379)** (Cinnadust) - 732 followers, 311 items in last 14d, active since 2025-11-22. Sample: 4 PG, 1 PG13.
- **#3 [Beautiful feeling](https://civitai.com/collections/9691988)** (vishnarjk) - 436 followers, 208 items in last 14d, active since 2025-05-02. Sample: 5 PG.
- **#5 [The Purple List](https://civitai.com/collections/13783073)** (purplelady) - 358 followers, 177 items in last 14d, active since 2025-11-19. Sample: 1 PG13, 4 PG.
- **#6 [Highly creative](https://civitai.com/collections/5205910)** (Daalis) - 355 followers, 5 items in last 14d, active since 2024-10-08. Sample: 5 PG.

## Justin-requested named collections (dropped - stale)

Both collections have `type=Image`, `mode=NULL`, `read=Public` (pass filters 1-4) but fail filter 5 - they have zero ACCEPTED items in the last 90 days, let alone 14.

| Collection | Owner | Followers | Total ACCEPTED | Last-14d | Last-90d | First ACCEPTED | Last ACCEPTED | Distinct months | Sample |
|:---|:---|--:|--:|--:|--:|:---|:---|--:|:---|
| [Outstanding AI-Art](https://civitai.com/collections/906833) | ArtifyAI | 2516 | 19841 | 0 | 0 | 2024-03-20 | 2025-05-13 | 13 | 4 PG, 1 PG13 |
| [The Precious.Art](https://civitai.com/collections/7162761) | fussypixel | 1187 | 14483 | 0 | 0 | 2025-01-12 | 2025-08-21 | 8 | 4 PG, 1 R |

**Read**: both were thriving PG/PG13 art-curation collections through mid-2025 then went dark. If you want them featured again, that is a curator-outreach decision, not an activity-signal pick.

## Caveats

- Sample size per collection is 5 items. Spot-check the cover image and a wider slice before featuring any.
- `CollectionMetric.followerCount` for `timeframe=AllTime` is used for ranking (matches prior list methodology).
- Activity-filter rationale: 23 collections >= 5 items in 14d already exceeds the 10-row floor in the brief, so no relaxation applied.
- Distinct-month count ignores timezone; treated as calendar months in server tz.

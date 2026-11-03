# Search engine comparison: OpenSearch vs Meilisearch

Signed-in users in the `site-search-opensearch` rollout get their **models** searches answered by
OpenSearch; everyone else stays on Meilisearch. The search UI is the same for both. The point is to
compare the two engines on real traffic before the rebuilt search ships
(`docs/search-replacement-plan.md`).

## Who is in which arm

| Viewer | Engine for models search | Everything else (users, articles, …) |
|---|---|---|
| Signed in, in the rollout | OpenSearch, falling back to Meilisearch | Meilisearch |
| Signed in, not in the rollout | Meilisearch | Meilisearch |
| Signed out | Meilisearch | Meilisearch |

- The rollout is a Flipt percentage on the user id, so a user stays in the same arm across visits
  and devices.
- Signed-out visitors are not split: Flipt evaluates them all as one `anonymous` entity, so a
  percentage would put all of them in one arm.
- The flag needs `siteSearchProxy` on, because only searches through `/api/search` can be routed.

## How a search is answered

The search UI sends Meilisearch-style requests to `/api/search`
(`src/pages/api/search/[...path].ts`). For a viewer in the OpenSearch arm, a models query goes to
`answerFromOpenSearch` in `src/server/services/site-search.service.ts`:

1. The viewer's scope (browsing-level cap, POI, private models, the owner exception) is added
   exactly as for Meilisearch.
2. The filter, sort, facets and paging are translated (`src/server/search/meili-filter.ts`,
   `src/server/search/opensearch/models-search.ts`) and run against the `models` alias.
3. The answer is returned in Meilisearch's response shape, so the UI does not know which engine
   answered.

The query goes to Meilisearch instead when the request uses something the translation does not
cover, when OpenSearch errors or times out (5 s), or when `OPENSEARCH_URL` is not set. Searching
inside a facet's values always uses Meilisearch. A fallback never fails a search.

## Measuring

Every query is counted once, by the arm the viewer is in (`cohort`) and the engine that answered
(`served_by`). Compare arms by `cohort`; `served_by` shows how much of the OpenSearch arm OpenSearch
actually carried.

| Question | Prometheus |
|---|---|
| p95 latency per arm | `histogram_quantile(0.95, sum by (le, cohort) (rate(civitai_app_site_search_duration_seconds_bucket{index="models_v9"}[5m])))` |
| Zero-result rate per arm | `sum by (cohort) (rate(civitai_app_site_search_queries_total{index="models_v9",hits="none"}[1h])) / sum by (cohort) (rate(civitai_app_site_search_queries_total{index="models_v9"}[1h]))` |
| Share of the OpenSearch arm that fell back | `sum by (reason) (rate(civitai_app_site_search_fallbacks_total[1h])) / sum(rate(civitai_app_site_search_queries_total{cohort="opensearch"}[1h]))` |
| Live writes OpenSearch missed | `rate(civitai_app_opensearch_mirror_failures_total[1h])` |

Every `/api/search` response carries `X-Search-Cohort` (the viewer's arm) and `X-Search-Engine`
(`opensearch`, `meilisearch` or `mixed` for a multi-search split between them).

**What counts as a win** — to be agreed before the ramp: at least the same click-through on search
results, a lower zero-result rate, p95 latency within the API's budget, and fallbacks under 1% of
the OpenSearch arm. Click-through per arm is not wired yet: the search tracking event does not carry
the arm, so it can only be compared by joining clicks to the rollout's user ids.

## Known differences between the arms

These are deliberate or accepted; reports about them are expected.

| Behaviour | Meilisearch | OpenSearch |
|---|---|---|
| Misspellings (`juggernaught`, `epicrealsim`) | A typo is only tolerated in words of 12+ characters, so these return nothing | Found |
| Searching by the civitai.com title | Not searched (the live index never got the field) | Searched, as decided on 2026-10-22 |
| Most downloaded / most tipped | Sorts on the displayed number, so models whose creator hides it sort as zero | Sorts on the real number; the hidden number is still never shown |
| Multi-word queries | Drops trailing words until something matches | Needs every word, with a weaker match on most words ranked below |
| Prefix highlighting in autocomplete (`juggern…`) | Highlighted | Not highlighted (the text still shows) |
| "Most favorited" sort | No models document has a favorite count, so the order is effectively relevance | Same |
| Result counts | Capped at 1,000 | Capped at 1,000 |

## Operating it

- **First build:** run the manual job `opensearch-models-build`. It builds a new index from the
  database and swaps the `models` alias to it when it finishes (about an hour). Run it again after a
  failure or cancel and it resumes from its checkpoint.
- **Staying current:** the Meilisearch models sync mirrors every write and delete to OpenSearch,
  including into a build that is still running. A mirror failure never fails the Meilisearch sync;
  watch `opensearch_mirror_failures_total`.
- **The moderator `models-update` tool** writes partial documents to Meilisearch only. After using
  it, run `opensearch-models-build` so OpenSearch catches up.
- **Rollback:** a bad build is undone with the manual job `opensearch-models-rollback`, which points
  the alias back at the previous build. Each build keeps one previous build.
- **Kill switch:** turn `site-search-opensearch` off in Flipt. Everyone is on Meilisearch from their
  next search.

## Rollout

1. OpenSearch provisioned and `OPENSEARCH_URL` (and credentials) set on the API pods. Ask an infra
   owner.
2. `opensearch-models-build` run to completion; spot-check searches with the flag on for yourself.
3. Create `site-search-opensearch` in Flipt, off. Enable it for moderators.
4. Enable it for 50% of signed-in users. Watch fallbacks and mirror failures for the first day.
5. After the agreed comparison window, decide on the criteria above: ramp to 100% or turn it off.

## Support guide

**Which arm is this user in?** Ask them to open the browser's developer tools, run a search, and
read the `X-Search-Cohort` header on the `/api/search` request. Or check the Flipt flag for their
user id. Only signed-in users can be in the OpenSearch arm.

**"Search results changed" / "search is different from my friend's"**: expected during the test;
half of signed-in users see the other engine. Collect the exact query, the page (models search page
or the top search bar), the filters and sort, and the `X-Search-Engine` value, and pass them to the
search channel.

**"I can't find a model by name"**: try the query with a typo and without. Check the known
differences above. If OpenSearch misses something Meilisearch finds (or the reverse), report it with
the details above; it is exactly what the test is for.

**A model shows outdated information in search** for OpenSearch-arm users only: a missed live write.
It corrects on the model's next change or the next build; report the model id.

**Taking one user out of the test** is not supported per user; the flag is a percentage. If search
is broken for someone, turn the flag off or ask an engineer.

## Release notes

**Internal (team and ops)**

- New: models search can be answered by OpenSearch for a percentage of signed-in users, behind the
  `site-search-opensearch` Flipt flag (dark at deploy). Requires `siteSearchProxy`.
- New: `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD` (server-only, optional). Unset
  means everyone stays on Meilisearch.
- New manual jobs: `opensearch-models-build` (resumable rebuild behind the `models` alias) and
  `opensearch-models-rollback`.
- New metrics: `site_search_queries_total`, `site_search_duration_seconds`,
  `site_search_fallbacks_total`, `opensearch_mirror_failures_total`.
- New response headers on `/api/search`: `X-Search-Cohort`, `X-Search-Engine`.
- The models search sync now also writes to OpenSearch when it is configured. No change to what
  Meilisearch receives.
- Nothing changes for signed-out visitors or for any index other than models.

**For users, when it reaches everyone** (draft for the changelog)

> **Better model search.** Search now finds models even when you misspell their name, searches the
> civitai.com title of a model as well as its original one, and sorts "most downloaded" by the true
> download count.

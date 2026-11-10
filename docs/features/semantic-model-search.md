# Semantic model search: the models collection

Models get one vector each in Qdrant, for the search service's model search. The pipeline is the
image one ([semantic-image-search.md](semantic-image-search.md)) with a text input: the same
`wemm-2b` model at 256 dimensions, through the orchestrator's `multimodalEmbedding` step with a
`text` input, and the same model-stamp check, so vectors from two models are never mixed.

Code: `apps/event-engine/src/vector-sync/models/`.

## The document

`modelDocument` ports `document()` from the model-search prototype: name, type, creator, tags,
base models, trigger words (first 64), description, and the names and descriptions of the first
three published versions, as labelled lines, cut to 5,000 code points. The same text is embedded
and stored as `search_text`. `docHash` (its sha256)
is stored with the point: a model whose document changed is re-embedded, and any other change
only rewrites the payload.

## Eligibility

Published, not deleted, not `tosViolation`, not `minor`, availability not `Unsearchable`, a
`publishedAt`, and at least one Published version that is not `Unsearchable`. The site still
applies access rules when it hydrates results, so the index is a candidate set, not the gate.

## Collection

`models_wemm2b_256_v1` (`VECTOR_MODEL_COLLECTION`) behind the alias `models_semantic`
(`VECTOR_MODEL_ALIAS`): cosine, INT8 scalar quantization in RAM (quantile 0.99), HNSW m 16 /
ef_construct 128, vectors and payload on disk.

| Payload                                               | Index                                            | Notes                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `title_normalized`                                    | keyword                                          | NFKC, lowercase, split on Python `str.isspace` whitespace, joined by one space; must equal the search service's query key |
| `search_text`                                         | text: word tokenizer, lowercase, phrase matching | the embedded document                                                                                                     |
| `type`, `checkpointType`                              | keyword                                          |                                                                                                                           |
| `baseModels`                                          | keyword                                          | from published versions                                                                                                   |
| `nsfwLevel`                                           | integer                                          | the set bits of `Model.nsfwLevel`; filter with `match.any` of the viewer's levels                                         |
| `publishedAt`                                         | datetime                                         | RFC 3339 UTC                                                                                                              |
| `userId`                                              | integer                                          | for hidden-user exclusion                                                                                                 |
| `versionIds`                                          | integer                                          | the versions the document was built from (up to 8); live sync only                                                        |
| `name`, `username`, `tags`, `triggerWords`, `docHash` | none                                             | display and the search service's dictionaries                                                                             |

Collection metadata holds the model stamp (`model`, `modelRevision`, `profile`, `dimensions`) and,
after a full backfill, `catalogBuiltAt` and `catalogPointsAtBuild`.

## Backfill

```
node dist/vector-sync/models/backfill.js --to <id> [--from <id>] [--limit N] [--page 500] \
  [--dry-run] [--confirm] [--stamp-catalog]
```

Walks model ids downward from `--to`, newest first, and logs `next` per page (the `--to` that
resumes). Each page also takes the collection's ids in its range, so the point of a hard-deleted
model is removed. `--limit N` stops after the first page by which N eligible models were synced,
for a first slice. Writing needs `--confirm` and `VECTOR_SYNC_EMBED_ENABLED`; embedding is a paid
orchestrator call. The embedder's config checks apply, including `VECTOR_IMAGE_LOCATION`.

A model whose document changed keeps its old vector until the re-embed lands, but its payload is
rewritten at once.

Run one writer per model: the post-embed re-read covers what was embedded, not deletes and
payload rewrites racing a second writer. Two writers that both sync a model while it changes can
leave the older read's payload, including its `nsfwLevel`, until the model's next change or a
re-run. The live consumer is such a writer, so run one replica of it; a backfill alongside it
races only within one page's read and payload write. The reverse race, a page that read a model as
ineligible deleting a point the consumer just made, leaves the model missing until its next event.

## Live sync

```
node dist/vector-sync/models/consumer.js
```

Its own process and consumer group (`VECTOR_MODEL_CONSUMER_GROUP`, default `model-vector-sync`).
It reads `postgres.Model`, `postgres.ModelVersion` and `postgres.TagsOnModels`, collects model ids
for `VECTOR_SYNC_DEBOUNCE_MS`, and runs the same sync as the backfill, committing offsets only
after the writes land.

- The connector must stream `public.Model` and `public.ModelVersion`, without their large text and
  JSON columns (a record over the producer's size limit would fail the connector for every table).
  Where the metrics watcher manages the connector (`DEBEZIUM_CONNECT_URL` set on it),
  `CDC_MODEL_ENABLED=true` on the watcher does that, recreating the connector. Where the connector
  is configured outside this app, add both tables and the column exclusions
  (`DebeziumManager.getColumnExclusions`) there, and add the tables to the Debezium publication
  first if the connector's role cannot. The consumer needs `CDC_MODEL_ENABLED=true` in its own
  env either way: it refuses to start without it.
- Start it before the backfill. A new consumer group starts at the latest offset, so changes
  before its first join are only covered by a backfill that runs after it.
- It embeds only with `VECTOR_SYNC_EMBED_ENABLED`, once the collection has a recorded model (the
  backfill's first write), and while Kafka Connect reports both tables streaming. Otherwise
  deletes and payload updates still run, and new vectors and re-embeds wait for the model's next
  event once embedding resumes, or for the backfill.
- A deleted version's event carries only the version id (and deleting a model's last published
  version writes nothing to the Model row), so the consumer finds the model through the point's
  `versionIds` and re-syncs it. A point written before `versionIds` existed is not found this
  way, so run a full backfill after this field first deploys; until then those deletes are
  missed (logged as `deleted versions matched no point`).
- A model whose embed step fails is counted in `failed` and its offset committed; the next change
  or a backfill re-run embeds it.
- `HEALTH_CHECK_PORT` reports `healthy`, `pending` and whether it is embedding.

## Caveats

- `title_normalized` is computed with the Unicode version of the Node runtime and the query key
  with Python's. They agree except for characters one version knows and the other does not.
- Private-availability models are indexed, as on the current search index, with their name and
  description in the payload. Results must be hydrated through the site's access rules, never
  returned from the payload.

## Not built yet

- A creator rename changes the `Creator:` line but is not detected; a re-run picks it up.
- The 1,024-token cap from the prototype: whether the orchestrator accepts or truncates documents
  that long is being measured.

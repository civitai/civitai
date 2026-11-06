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
and stored as `search_text`, so phrase filters and the vector see one text. `docHash` (its sha256)
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
| `name`, `username`, `tags`, `triggerWords`, `docHash` | none                                             | display and the search service's dictionaries                                                                             |

Collection metadata holds the model stamp (`model`, `modelRevision`, `profile`, `dimensions`) and,
after a full backfill, `catalogBuiltAt` and `catalogPointsAtBuild`.

## Backfill

```
node dist/vector-sync/models/backfill.js --to <id> [--from <id>] [--limit N] [--page 500] \
  [--dry-run] [--confirm] [--stamp-catalog]
```

Walks model ids downward from `--to`, newest first, and logs `next` per page (the `--to` that
resumes). `--limit` stops after N models have a point, for a first slice. Writing needs `--confirm`
and `VECTOR_SYNC_EMBED_ENABLED`; embedding is a paid orchestrator call.

## Not built yet

- Change capture: Model and ModelVersion are not streamed by the Debezium connector today, so until
  it lands an edit, unpublish or delete reaches the collection only through a backfill re-run.
- A creator rename changes the `Creator:` line but is not detected; a re-run picks it up.
- The 1,024-token cap from the prototype: whether the orchestrator accepts or truncates documents
  that long is being measured.

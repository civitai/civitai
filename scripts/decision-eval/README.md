# Decision-model eval harness

This harness evaluates decision models offline. It runs a model over a labelled manifest and reports, per question:

- agreement and Cohen's kappa
- precision per predicted class, with a Wilson 95% lower bound
- per-class thresholds fitted on dev
- coverage, abstention rate and calibration error
- every metric again for each slice

It sends to two arms:

- a self-hosted imajev server (`imajev-client.ts`)
- hosted Jev through `src/server/services/ai/jev.ts` (`jev-arm.ts`)

A domain adds a `NodeSpec` (`nodes.ts`). The harness owns splits, routing, controls and scoring.

## Data stays out of this repo

Every data file lives under `--data-dir`, and the CLI refuses a directory inside any git checkout.

| Data                                    | Handling                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Text state                              | Stored as the node's redacted `buildState` output. The runner refuses any state containing an email, URL or @handle. |
| Images                                  | Stored only as references. They are fetched into memory per run and never written anywhere.                          |
| Question wording that must stay private | A format may declare `questions: { fromDataDir: '<file>.json' }`.                                                    |

## Routing

| Data class         | Allowed arms                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `moderation-image` | Self-hosted only. No override.                                                                |
| Any text class     | Also allowed on a third-party arm that sends zero data retention (`provider: { zdr: true }`). |

The imajev URL must be loopback, a private address, or a host named with `--allow-host`. The server has no auth and must never be bound to a public address.

## Layout under `<data-dir>/<node-id>/`

| File                               | Contents                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `manifest.jsonl`                   | One `ManifestItem` per line. An item keeps its split for life. A rebuild only appends. |
| `gold.jsonl`                       | `GoldRow`s. The majority wins; ties are dropped.                                       |
| `eval-index.v1.json`               | Every item id and group key a dev or test split has held. See below.                   |
| `controls.jsonl`                   | Each passing known-answer call, keyed by run key.                                      |
| `sealed-test.json`                 | When each run key's sealed test was scored.                                            |
| `runs/<run-key>/predictions.jsonl` | Appended per item, with status `ok`, `missing` or `error`.                             |
| `runs/<run-key>/report-<split>.md` | The report for that split.                                                             |

A run key is a hash of the model's launch configuration plus the question spec. Predictions are therefore reused only when both are unchanged.

## `eval-index.v1.json`

The training-manifest builder reads this file to keep eval items out of any training set.

```json
{
  "schema": "civitai.decision-eval.eval-index",
  "version": 1,
  "nodeId": "<node id>",
  "updatedAt": "<ISO timestamp>",
  "itemIds": ["<sorted, unique>"],
  "groupKeys": ["<sorted, unique>"]
}
```

- The index only grows. An id that was once eval stays out of training for good.
- A training row collides if its item id or its group key is listed, in either trainer partition (`train` or `trainer-dev`).
- The group key must be computed exactly as the node's `source()` computes it.
- A breaking change ships as `eval-index.v2.json`.

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

Every data file lives under `--data-dir`. The CLI resolves links and refuses a directory inside any git checkout.

| Data                                    | Handling                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Text state                              | Stored as the node's redacted `buildState` output. The runner refuses any state containing an email, URL or @handle. |
| Images                                  | Stored only as references. They are fetched into memory per run and never written anywhere.                          |
| Question wording that must stay private | A format may declare `questions: { fromDataDir: '<file>.json' }`.                                                    |

A node file is public. Keep anything decision-rule-shaped for content safety (label definitions, carve-outs, thresholds) in the data dir, not in the node.

## Routing

| Data class         | Allowed arms                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moderation-image` | A self-hosted arm on loopback or a host named with `--allow-host`. A bare private range is refused, because it also matches a rented machine on a VPN. No override. |
| Any text class     | Any self-hosted arm on a private address, or a third-party arm that sends zero data retention (`provider: { zdr: true }`).                                          |

The imajev URL must be loopback, a private address or an allowlisted host, and the client refuses redirects. Bind the server to a private address only.

## Exclusions

A moderation node must define both of these:

- **`exclude(raw)`:** checks each row as it is sampled.
- **`excludedIds()`:** lists every item currently excluded, regardless of when it was sampled. A rolling source never hands an old row back, so only this catches a report that lands after sampling.

The harness folds both into `excluded.v1.json` on every `build` and again before every `run`. An excluded item:

- leaves the manifest and never returns;
- is never sent to a model;
- is refused by `train-manifest`.

The guarantee is only as good as the node's two functions.

## Layout under `<data-dir>/<node-id>/`

| File                                     | Contents                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.jsonl`                         | One `ManifestItem` per line. An item keeps its split for life. A rebuild appends, and removes only excluded items.                                                                                                                                           |
| `gold.jsonl`                             | `GoldRow`s, one per labeller per item: a rebuild replaces a labeller's earlier label with their current one. Resolved by the node's `goldPolicy`: majority vote (ties dropped and counted) by default, a primary labeller, or disagreement as its own class. |
| `eval-index.v1.json`                     | Every item id and group key a dev or test split has held. See below.                                                                                                                                                                                         |
| `excluded.v1.json`                       | Every item id ever excluded. Only grows.                                                                                                                                                                                                                     |
| `controls.jsonl`                         | Each passing known-answer call, keyed by run key.                                                                                                                                                                                                            |
| `sealed-test.json`                       | Every scoring of a sealed test split. The report shows how many came before it.                                                                                                                                                                              |
| `runs/<run-key>/predictions.jsonl`       | Appended per item, with status `ok`, `missing` or `error`. A failing item is retried on later runs, up to three failures.                                                                                                                                    |
| `runs/<run-key>/report-<split>.md`       | The report for that split.                                                                                                                                                                                                                                   |
| `runs/<run-key>/thresholds-<split>.json` | The per-class targets and the thresholds fitted on dev that the report used.                                                                                                                                                                                 |
| `train-manifest.jsonl`                   | `train-manifest` output: the training candidates that passed the leakage and exclusion checks.                                                                                                                                                               |
| `trainer-datasets/<name>.zip`            | `train-dataset` output: the zip the imajev training engine takes. See below.                                                                                                                                                                                 |
| `trainer-datasets/<name>.json`           | The zip's sha256, row counts, and the training workflow to submit once the zip is uploaded.                                                                                                                                                                  |

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

## Training datasets

`train-dataset --node <id> --format <f>` turns `train-manifest.jsonl` into the dataset the orchestrator's `imajev` training engine takes:

- It re-runs the leakage and exclusion checks against today's eval index and exclusions. Both only grow, so a manifest that passed yesterday can fail today.
- Each row's targets come from the format's `trainTargets(gold)`, the inverse of `mapAnswer`. A format without it cannot train. `choiceTargets` covers a format whose classes are its option keys. Its `unknownClasses` option trains the named classes as imajev's own unknown answer instead of as their option, e.g. a "cannot tell" class.
- Gold is resolved with the node's `goldPolicy`, the same way `score` resolves it.
- Rows with no resolved gold, a class the format cannot express, or a PII-shaped state are skipped and counted.
- `trainer-dev` becomes the trainer's `dev` partition, which only picks its best checkpoint. A group may sit in only one of the two partitions.
- These are refused:
  - moderation nodes and rows with images;
  - a group in both trainer partitions. The harness allows it, but it would flatter checkpoint selection.
- `buildTrainManifest` checks every row before anything else, in both `train-manifest` and `train-dataset`. It refuses a row:
  - whose ids are not non-empty strings, since a number never equals the index's string ids;
  - whose id or group key looks like personal data, checked before any refusal that names the item;
  - whose partition is unknown;
  - whose state is not an object of strings.
- A choice question's options are written in the order serving sends them. Serving sends `criteria` as a JS object, which lists integer-like keys first.
- The manifest is built as one string, so a few tens of thousands of multi-KB tickets is the ceiling. `train-manifest` has the same limit at about twice the rows.

The zip holds `data/manifests/decision.jsonl`. Each row carries imajev's internal request, built by `toImajevRequest`, and the Jev-style payload serving sends. `toImajevRequest` ports imajev's `jev_api.to_request`. `scripts/__tests__/fixtures/imajev-to-request/golden.json` pins it to imajev's own output at `IMAJEV_TO_REQUEST_COMMIT`; regenerate it with `generate.py` beside it when that pin moves.

Nothing is submitted. The training step is privileged: upload the zip, put its AIR in place of the placeholder in the sidecar's `workflow`, and submit that.

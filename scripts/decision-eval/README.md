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

A moderation node must define `exclude()`, and every item it excludes goes into `excluded.v1.json`. An excluded item leaves the manifest and never returns, even if it was sampled before it was reported. The guarantee is only as good as the node's `exclude()`.

## Layout under `<data-dir>/<node-id>/`

| File                                     | Contents                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.jsonl`                         | One `ManifestItem` per line. An item keeps its split for life. A rebuild appends, and removes only excluded items.                                          |
| `gold.jsonl`                             | `GoldRow`s, resolved by the node's `goldPolicy`: majority vote (ties dropped and counted) by default, a primary labeller, or disagreement as its own class. |
| `eval-index.v1.json`                     | Every item id and group key a dev or test split has held. See below.                                                                                        |
| `excluded.v1.json`                       | Every item id ever excluded. Only grows.                                                                                                                    |
| `controls.jsonl`                         | Each passing known-answer call, keyed by run key.                                                                                                           |
| `sealed-test.json`                       | Every scoring of a sealed test split. The report shows how many came before it.                                                                             |
| `runs/<run-key>/predictions.jsonl`       | Appended per item, with status `ok`, `missing` or `error`. A failing item is retried on later runs, up to three failures.                                   |
| `runs/<run-key>/report-<split>.md`       | The report for that split.                                                                                                                                  |
| `runs/<run-key>/thresholds-<split>.json` | The per-class targets and the thresholds fitted on dev that the report used.                                                                                |

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

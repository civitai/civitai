# Minor detection review mode

Lets moderators decide whether a text-scan `minor` detection on a model becomes a flag, instead of the
scan applying it automatically.

## Why

The web-search pass decides `minor` and `poi` on models and today applies the flag immediately:
`minor` is set, the property is locked and the owner is notified. Wrong flags reach owners before any
human looks at them. Review mode puts a moderator between the verdict and the flag, and every decision
is recorded so the scan's precision can be measured per prompt version.

## The switch

A per-label sys-Redis hash, separate from the per-entity rollouts:

```
system:text-scan:label-modes
  minor → "review"
```

- A missing field means `auto` — today's behaviour. Deploying the code changes nothing. (`csam` is the exception: it has its own `off`/`review` field, and a missing field means `off`; see [text-scan.md](text-scan.md).)
- Only consulted when the scan's verdict can act (the entity's rollout is `active`). A `shadow`
  rollout still records verdicts and does nothing else.
- Read through the same short TTL memo as the rollouts; written only through a guarded setter that
  checks the moderator and logs the change.
- `poi` is switchable the same way (`label: "poi"`); it has no field today, so it stays `auto`. `csam` is not: it takes `off` or `review` only, and `putLabelModes` refuses `auto` for it.
- Set with the harness action `putLabelModes` (`{ "action": "putLabelModes", "label": "minor", "mode": "review" }`;
  `"auto"` removes the field); `getPrompts` returns the current value as `labelModes` (`csam` is returned separately as `csamMode`).

## What happens on a detection

`classifyDetection` gains a fourth outcome:

| State of the model                                 | `auto`        | `review`                |
|----------------------------------------------------|---------------|-------------------------|
| Already flagged / label locked                     | skip          | skip                    |
| A moderator cleared this exact text                | skip          | skip                    |
| A moderator cleared other text (re-detection)      | hold (#6062)  | hold (#6062)            |
| No moderator ruling                                | flag          | **hold, first detection** |

A first-detection hold writes the same `meta.textScanFlags.minor.redetected` marker a re-detection
does (so the queue's partial index is unchanged), shaped `{ kind: 'first' | 'redetected', at,
workflowId, reason, textHash, promptIds, model }`. A marker with no `kind` predates it and is a
re-detection. The same text detected again keeps its original `at`, so a held item does not slide
down the queue.

While a detection is held the model is **visible as-is** — no restriction, no lock, no owner notice.
Held items do not expire automatically.

If the owner edits the model and the new text scans clean, the held marker for the old text is
dropped; if the new text is detected, the marker moves to it. A clean verdict on the very text that
is held leaves the marker alone.

## Moderator decision

Both decisions go through the existing `POST /api/mod/minor-flag/resolve-redetection` (hash-bound,
locked per model and label, refused while an appeal is pending, resumable keep).

- **Flag** applies the flag exactly as the scan would have: property set, locked, previous state
  snapshotted, owner notified.
- **Don't flag** drops the marker and records a moderator ruling on that text, so the same text is
  never held again. A later detection on different text becomes an ordinary re-detection.

Each decision is logged (`held detection resolved`) with the label, the hold kind, the decision
(`kept`, `dismissed`, or `closed` when the item was already resolved), the prompt ids that
produced the verdict, and the moderator's `reason` and `note` (absent on `closed`).

## Moderator app

The **Needs review** tab of Model Flags (`/models/flags/needs-review`, see
[moderator-model-flags.md](moderator-model-flags.md)) lists first detections and re-detections together with
file matches (nothing applied for either), each badged with its kind, in the shared triage layout: **Flag (1)** /
**Don't flag (2)**. Detections show only to holders of the `modelFlags.detections.decide` permission. It
replaces the Held Detections page; the old `/models/held-detections` and
`/models/flag-appeals?view=redetected` URLs redirect to `/models/flags/needs-review?source=text-scan`. The tab lists held poi (real person) re-detections as well as minor ones, so it is not minor-only. Each verdict requires a reason from a fixed list (plus a note for Other), sent as `resolvedReason`/`internalNotes` on `resolve-redetection` and stamped on the label's decision; the server treats both as optional.

## Rollout

1. Deploy main app and moderator app.
2. A moderator sets `minor → review`.
3. Rollback: remove the field. Held items stay in the queue for moderators to finish; new detections
   flag automatically again.

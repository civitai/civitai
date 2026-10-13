# Text Scan

One mechanism for scanning user-written text with an LLM and acting on the result. A scan is one
orchestrator workflow of `chatCompletion` steps with a strict JSON schema: one step for most texts,
one per segment for long ones. The verdict is recorded on `EntityModeration` and handed to the
entity's moderation adapter, which applies the action.

## Pieces

| piece                                                                       | where                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Scan profiles (which fields, which labels, the entity's declared state)     | `src/server/services/text-scan/profiles/`                   |
| Prompt storage (append-only table, cached; content is never in the repo)    | `TextScanPrompt`, `text-scan/prompt.ts`                     |
| Model, per-call size (maxInputChars) and segment-count (maxSegments) config | sysRedis `system:text-scan:config`                          |
| Submit, dedup (`contentHash`), external id                                  | `text-scan/submit.ts`                                       |
| Callback                                                                    | `/api/webhooks/text-scan-result`                            |
| Retry of failed scans                                                       | the `retry-failed-text-moderation` job (shared with XGuard) |
| Row retention                                                               | the `text-scan-retention` job                               |
| Actions per label                                                           | `text-scan/actions/` and each entity's moderation adapter   |

**Long input.** An entity's fields are composed into one text. Text up to `maxInputChars` (default
200,000 characters) is scanned whole in one call. Longer text is split into segments of at most that
size, between fields first and then at paragraph, line or word breaks; each continuation repeats its
field heading and re-reads the end of the previous piece. All segments run as steps of one workflow,
and their verdicts merge: the highest nsfw level, and a flag if any segment raised it. Each step bills
like a single call. At most `maxSegments` (default 10) segments are scanned. Any failed, refused or
missing segment fails the whole scan, which the retry job then resubmits. The segments that did parse
can still raise the stored verdict straight away: a higher nsfw level, or a poi, minor or scam flag
the row does not already carry. Nothing is lowered or cleared, the row stays Failed, and modes apply
as for a full verdict (shadow acts on nothing; an active search pass owns Model poi/minor). The retry
job resubmits a row while its `retryCount` is below 9, and every failed attempt adds one, so an entity
gets its first scan and at most 8 retries; the count is not reset when the text changes. Every result's `meta`
records `inputChars`, `inputCut` (some text was past the last segment and was not scanned), `segments`
and `scannedChars`. Both limits can be overridden in the config above. The dedup hash covers the whole
text, so an edit anywhere rescans. For text longer than `maxInputChars` it also covers both limits, so
changing either rescans long entities on their next trigger; text within the limit keeps its hash.

## Entities

The scanned entities, and the fields and labels each scans, are the profiles in
`src/server/services/text-scan/profiles/`. Once Crucible is active, its scan (name, description →
`nsfw`) replaces XGuard; off or in shadow, XGuard still runs. Collection's (name, description of
Public collections readable as Public or Unlisted → `nsfw`, a floor on the collection's rating)
replaces Clavata only once Collection is cut over with `disableClavataFor`.

## Actions

A label's action is one of: raise the content rating (the owner can dispute it), restrict the entity
(the owner can appeal), or mute the account pending moderator review. Disputes, appeals and mute
reviews go through the existing moderator queues; text scan adds no queue of its own.

## Modes

Each entity type has a rollout in the sysRedis hash `system:text-scan:modes`: field = entity type,
value = `{ "shadow": 0-100, "active": 0-100 }`, the percentage of entity ids in each mode. An id
falls in a fixed bucket (0–99), so raising a percentage only adds ids; `active` is checked first. A
missing field is off. It is set with the harness action `putModes`, which refuses any `active` share
without `allowActive: true` and logs who changed it; pods pick a change up within 15 seconds.

Above the rollout sits the Flipt boolean `text-scan`, a kill switch. Off, or Flipt unreachable,
every entity type is off whatever the hash says, so XGuard and the profanity filter run as before, and
Clavata runs again for any entity cut over by `disableClavataFor` (the cutover is kept in its own
set, `system:text-scan:clavata-cutover`, and the Clavata job skips a cut-over entity only while the
switch is on and that entity type is 100% active; anything less hands it back to Clavata).
Turning it off does not undo verdicts already applied.

- **off** — nothing is submitted.
- **shadow** — scans run and verdicts are written to a separate `<Entity>:shadow` row that nothing
  reads; no action runs.
- **active** — verdicts are written to the entity's row and actions run.

A verdict that arrives after the mode has left `active` is not written to the live row.

## Web-search pass (Model poi/minor)

Whether a name is a real person, or how old a named character is, often needs outside knowledge.
For Model only, a second scan can run with the orchestrator's `civitai:web_search` tool, asking only
for `poi` and `minor`. It is slower and uses many more tokens than the main scan, so it has its own
rollout: the sysRedis hash `system:text-scan:web-search`, same shape and bucket as the modes hash
(`{ "shadow": 0-100, "active": 0-100 }`, field `Model`). A missing field is off. An id's search mode
never exceeds its main mode, and the `text-scan` kill switch turns both off.

- **shadow** — the main scan is unchanged; the search scan writes to its own `Model:search-shadow`
  row and logs `scan-verdict` with `variant: 'web-search'` and `acted: false`. It never acts.
- **active** (main scan also active) — the main scan stops asking for `poi`/`minor`; the search scan
  writes to `Model:search` and its `poi`/`minor` verdict goes through the Model adapter. `nsfw` only
  ever comes from the main scan, and neither scan clears a flag the other set.

Both scans share the subject, input cap, segmentation, prompt rows and dedupe rules; a long text
splits into the same segments in both, so a long Model text costs up to 2 × `maxSegments` calls per
scan; every search-scan step carries the tool, and any failed segment fails that scan alone. Each row has its own retry adapter. Set it with the harness action `putWebSearchModes` on `/api/mod/text-scan`:

```json
{ "action": "putWebSearchModes", "entityType": "Model", "rollout": { "shadow": 10 } }
{ "action": "putWebSearchModes", "entityType": "Model", "rollout": { "shadow": 100, "active": 10 }, "allowActive": true }
{ "action": "putWebSearchModes", "entityType": "Model", "rollout": null }
```

Any entity type other than Model is refused, any `active` share needs `allowActive: true`, and the
change is attributed to the signed-in moderator. `getPrompts` returns the current value as
`webSearchModes`.

## Comparing with the existing systems

Every finished verdict is logged to Axiom as `name: 'scan-verdict'`, with `system` = `text-scan`
(shadow and active), `xguard` (its result callback) or `clavata` (the entity-moderation job, clean
results included). Each event carries the entity type and id, `flagged`, `acted`, and the
system's labels; no user text is logged. The profanity filter's verdict is stored on the entity
(`profanityEvaluation` on `Model.meta` and `Bounty.details`). Clavata scans chat as `Chat` windows,
so chat verdicts don't pair one to one with text scan's per-message ones.

## Shipped with text scan, whatever the mode

- The Clavata scam auto-mute files a Pending scam case and one `Scam` strike, and sends one "Account
  restricted" notice; see `docs/moderator-app/strike-rules.md`.
- Bounty awards are recorded under the payout lock, then paid with one key shared by the manual and
  expiry paths (`bounty-award-b<bountyId>-<accountType>`), so a retry can't pay twice. The hourly
  `bounty-payout-retry` job settles awards recorded but not yet marked paid.

## Adding an entity or a label

1. A profile file under `profiles/`, imported by the barrel.
2. A prompt row for any new label, inserted through the harness's `putPrompt` (never in a migration).
3. An adapter with `applyTextScan`, registered in `moderation-adapters.ts`.
4. A rollout through `putModes`, `off → shadow → active`.

## Testing and operations

- `src/server/services/text-scan/harness.ts` composes the production prompt for a real entity and
  scans it synchronously without recording it (`scanEntity`, `batchEntities`), does the same for free
  text (`scanTexts`), prices either without running (`quoteEntities`, `quoteTexts`, `whatif`),
  returns the composed text only (`composeEntities`), or samples shadow verdicts for grading
  (`sampleShadow`). `scanEntity`, `batchEntities` and `scanTexts` refuse a request whose worst case,
  `ceil(items / concurrency) * wait`, exceeds 120 seconds (`HARNESS_BUDGET_SECONDS`). Locally, the
  scan and quote actions are reached through `/api/testing/chat-completion-scan`. `composeEntities`
  and `sampleShadow` read any entity's text and author, so they are refused there (403) and only the
  attributed, audited moderator endpoint `/api/mod/text-scan` serves them. Like every moderator
  endpoint it takes a moderator's session or full-access personal API key. That endpoint also
  attributes prompt and config writes to the signed-in moderator.
- The moderator app's text-scan lab drives those actions: Check (`/text-scan/check`) judges links, ids
  or text with the current prompts and, side by side, with a moderator's edits, which are kept only in
  that moderator's browser; Versions (`/text-scan/prompts`) shows each prompt's history. It stores
  nothing in the moderator database. Publishing edits needs the `textScan.prompt.publish` permission,
  held by no one until granted on `/admin`; the pages are likewise unreachable until granted there.
  `/text-scan` and `/text-scan/playground` redirect to Check.
  The lab, Check included, accepts up to 600,000 characters per text, so a long text scans as up to three segments; its
  quotes and results report the segment count.
- Errors are logged to Axiom under `name: 'text-scan'`; every submit also logs a `submitted` event.

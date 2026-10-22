# Text Scan

One mechanism for scanning user-written text with an LLM and acting on the result. A scan is one
orchestrator workflow of `chatCompletion` steps with a strict JSON schema: one step for most texts,
one per segment for long ones. The verdict is recorded on `EntityModeration` and handed to the
entity's moderation adapter, which applies the action.

## Pieces

| piece                                                                                 | where                                                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Scan profiles (which fields, which labels, the entity's declared state)               | `src/server/services/text-scan/profiles/`                   |
| Prompt storage (append-only table, cached; content is never in the repo)              | `TextScanPrompt`, `text-scan/prompt.ts`                     |
| Model, per-call size (maxInputChars) and segment-count (maxSegments) config           | sysRedis `system:text-scan:config`                          |
| Submit, dedup (`contentHash`), external id                                            | `text-scan/submit.ts`                                       |
| Callback                                                                              | `/api/webhooks/text-scan-result`                            |
| Retry of failed scans                                                                 | the `retry-failed-text-moderation` job (shared with XGuard) |
| Row retention                                                                         | the `text-scan-retention` job                               |
| Actions per label                                                                     | `text-scan/actions/` and each entity's moderation adapter   |
| Model-rule storage and history (append-only versions, written with every rule change) | `ModerationRule`, `ModerationRuleVersion`                   |

**Long input.** An entity's fields are composed into one text. Text up to `maxInputChars` (default
200,000 characters) is scanned whole in one call. Longer text is split into segments of at most that
size, between fields first and then at paragraph, line or word breaks; each continuation repeats its
field heading and re-reads the end of the previous piece. All segments run as steps of one workflow,
and their verdicts merge: the highest nsfw level, and a flag if any segment raised it. Each step bills
like a single call. At most `maxSegments` (default 10) segments are scanned. Any failed, refused or
missing segment fails the whole scan, which the retry job then resubmits. The segments that did parse
can still raise the stored verdict straight away: a higher nsfw level, or a poi, minor or scam flag
the row does not already carry. Nothing is lowered or cleared, the row stays Failed, and modes apply
as for a full verdict (shadow acts on nothing). The retry
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
Storyline's (title → a rating and a takedown or restriction on the storyline) is applied by
`text-scan/actions/storyline.ts`; what readers see is in `docs/features/storylines.md`.

ChatMessage, Comment, CommentV2, UserProfile, Post, Model and Article also list `csam`, asked only while its
gate is `review` (see Modes). A chat window is scanned only for senders a scam verdict could act on;
in `review` every sender's window is scanned, and the others are asked for `csam` alone, still one
workflow per window.

### Model rules

Model rules are matched deterministically (no LLM) against each enabled `ModerationRule` row with
`entityType = Model` and a `semantic` definition (`subject`, `description`, `aliases`). A match is
recorded as a `TextScanHold` with label `modelRules`, held for a moderator rather than acted on by the
scan.

Moderators rule on a hold in the moderator app's `/models/rule-matches` queue, through
`POST /api/mod/text-scan/model-rules-hold/resolve`, with one of four rulings: Confirm, Confirm +
strike, Dismiss not this subject, or Dismiss allowed use. A ruling and its label-store rows are written
in one transaction. Model-rule takedowns are not listed in Models Needing Review.

The `ModelRules` mode decides what a match does:

- **active** (Auto): the model is held for review instead of publishing, and a dismissal republishes
  it. The owner sees a neutral "being reviewed" message.
- **shadow** (Review): the model stays live until a moderator confirms the match.
- **off**, or the Flipt switch off: the check does not run.

Rules are managed on the moderator app's `/text-scan/model-rules` page. Every create, edit,
enable/disable and restore of a rule writes a row to `ModerationRuleVersion` in the same transaction,
so each rule has a history that can be compared and restored; a rule saved before that table existed
gets its earlier state recorded on its next save. The `ModerationRuleVersion` table is created by a
hand-applied migration; apply it before deploying the moderator app, since a rule save writes its
version row in the same transaction. Alias suggestions come from an orchestrator call with web search
and are applied only when a moderator approves them; an Alias backfill tab does this across existing
rules. A search outlasts any request, so it is asynchronous: `suggestModelRuleAliases` submits the
billed workflow (tagged `model-rule-aliases`) and returns its id, and `aliasSuggestionResult` reads it
back (only workflows with that tag). The moderator app stores the id per rule in the browser as soon
as it exists and polls; a reload resumes polling and never submits again, and only a search that
really failed is re-submitted, by an explicit retry. The page's Try panel runs the matcher on pasted text, a link or an id (no LLM, no prompt).

Rules written before this check are regex; a one-off endpoint, `/api/admin/temp/convert-model-rules`
(`count`, then `apply`), converts them in place once per environment. A rule that cannot be converted
ends disabled and flagged until a moderator rewrites it, and nothing in the response or its log
carries rule text.

Image moderation rules are separate and stay in Retool; `/api/mod/mod-rules` now accepts Image rules
only, so a Model rule can only be managed on `/text-scan/model-rules`. An Image rule is built from
`content`, `tag`, `and` and `or` nodes only; any other node type is refused there and never matches if
stored. Each create or update writes a `ModerationRuleVersion` row in the same transaction.

## Actions

A label's action is one of: raise the content rating (the owner can dispute it), restrict the entity
(the owner can appeal), mute the account pending moderator review, or, for `modelRules`, hold the
match for a moderator (see Model rules). Disputes, appeals and mute reviews go through the existing moderator queues
(a storyline title appeal is on Storylines > Title Appeals).

`csam` is the exception: a positive verdict writes a `TextScanHold` row and nothing else (no report,
mute, strike, hide or notification). Every type except `ChatMessage` keeps one Pending hold per
entity: changed text updates it in place (earlier held text is kept on the hold), text a moderator
already ruled on adds nothing unless a different text is pending, and changed text after a ruling
inserts a new hold marked `redetected` (see
[text-scan-csam-holds.md](text-scan-csam-holds.md#one-hold-per-entity)). A chat window adds nothing
when the sender's newest Pending hold in that chat, or the newest decided one, already covered every
message in it.
A verdict requested in `review` is held even if the gate turned off before it landed. The scam, Post
and Model adapters write the hold before their own action. A failed hold write is logged as an error and fails the callback before
that action runs, so the row is marked Failed and the retry cron rescans it; the action has not run,
so it is not applied twice. Moderators work the holds on the moderator
app's CSAM text holds queue; see [text-scan-csam-holds.md](text-scan-csam-holds.md).

Every moderator ruling on a Model's `minor` or `poi` flag that carries a text-scan verdict (keep,
lift, confirm, revert, appeal, held-detection keep or dismiss) is also recorded in the label store, in
the same transaction as the ruling: family `text_scan`, questions `text_scan.model.minor` /
`text_scan.model.poi`, values `flag` / `clear`, with the scanned text when it is unchanged
(`text-scan/label-capture.ts`; see `docs/features/label-store.md`). A flag with no verdict records
nothing, and a store that is missing, refuses or is slow never fails the ruling: the label is dropped
and logged.

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
  ever comes from the main scan, and neither scan clears a flag the other set. An edit that both
  raises the rating and sets `poi`/`minor` sends the owner two notices, one per scan; deduplicating
  them would risk dropping one.

A scan acts on the labels it was submitted with, whatever the search rollout says when its verdict
arrives: a main scan submitted before the search pass went active still acts on its `poi`/`minor`,
and an active search scan still acts after the search rollout steps back, as long as the main mode
is still active. Changing the rollout rescans nothing by itself. Existing models keep the flags they
have; each model's next scan (an edit, a publish, a retry) uses the new split. The label set is part
of the dedup hash, so that scan resubmits even when the text has not changed.

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

A `poi` or `minor` detection can be held for a moderator instead of flagging immediately. The switch
is a per-label field, set with `putLabelModes` (`{ "action": "putLabelModes", "label": "minor", "mode": "review" }`;
`"auto"` removes it) and returned by `getPrompts` as `labelModes`. See
[minor-detection-review.md](minor-detection-review.md).

`csam` has its own field in the same hash, with modes `off` and `review` only; it never acts on its
own, so `putLabelModes` refuses `auto` for it. A missing or unreadable field reads as `off`. While
it is off, every scan drops `csam` from the profile's labels before prompts are looked up and the
content hash is computed, so no `label:csam` prompt is needed and no hash changes; switching it to
`review` changes the hash of the profiles that list it, and each of those entities is rescanned once.
`putLabelModes` refuses `review` until an active `label:csam` prompt exists; if one goes missing
later, scans drop `csam` alone (logged as a missing prompt) and keep the other labels. A shadow scan
never asks for `csam`, since only an active verdict reaches the adapter that holds it.
A harness `labels` override is never filtered. `getPrompts` returns it as `csamMode`.

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
  (`sampleShadow`). The `literalModelRules` action takes lab-only `ruleOverrides` (a positive id
  replaces that Model rule, a negative id adds an unsaved one, `enabled: false` drops it) and returns
  the enabled `rules` (`id`, `subject`) plus, per text, the rules it matched.
  `batchEntities` and `scanTexts` take an optional `labels` list that replaces the profile's labels,
  so a label no profile requests yet can be scanned; a label without a prompt row or override comes
  back as that item's missing-prompt error. A scan
  returns the `system` prompt it sent; `batchEntities` and `scanTexts` return `{ results, system, ... }`,
  carrying `system` once for all results. `scanEntity`, `batchEntities` and `scanTexts` refuse a
  request whose worst case, `ceil(items / concurrency) * wait`, exceeds 120 seconds (`HARNESS_BUDGET_SECONDS`). Locally, the
  scan and quote actions are reached through `/api/testing/chat-completion-scan`. `composeEntities`
  and `sampleShadow` read any entity's text and author, so they are refused there (403) and only the
  attributed, audited moderator endpoint `/api/mod/text-scan` serves them. Like every moderator
  endpoint it takes a moderator's session or full-access personal API key. That endpoint also
  attributes prompt and config writes to the signed-in moderator.
- Dry runs reproduce the web-search pass with `pass: "web-search"` on `scanEntity`, `batchEntities`,
  `scanTexts`, `quoteEntities` and `quoteTexts` (Model only). It asks only for `poi` and `minor`, with the
  `civitai:web_search` tool, through the same prompt composition and step builder production uses, so
  `promptOverrides` apply. The default `pass: "main"` is unchanged: every profile label, no tool.
  The two passes are separate calls; each result names its `pass` and the `labels` it judged, with the
  per-label verdicts under `parse.output` and `costTotal` when the orchestrator returned one. The
  search pass is a harness option, not gated by the search rollout, and still writes nothing.
- The moderator app's text-scan lab drives those actions from two pages.
  Prompts (`/text-scan/prompts`) lists every prompt key; a key's edits are a draft kept in that
  moderator's browser, Save writes a new version in one step (a note is optional), and a save is
  refused if someone saved a newer version after the draft started (`putPrompt`'s `baseId`, checked
  inside the insert's transaction). History compares any two of the last 20 versions and restores one
  as a new version, reading its text by id. Its Try panel takes pasted text, links or ids and shows the
  current and the edited verdicts side by side with the system prompt each side sent. Model rules
  (`/text-scan/model-rules`) manages the rules with their history and has its own literal Try (no LLM,
  no prompt). The lab reads a model's text whatever its visibility; it records nothing. Saving prompts
  needs `textScan.prompt.publish` on Prompts and `textScan.modelRules.edit` on Model rules; both are held by no one until granted on `/admin`, as are the pages. `/text-scan`, `/text-scan/check`
  and `/text-scan/playground` redirect to Prompts; roles granted the old Check or Playground pages
  are moved to Prompts by a one-off migration applied after the moderator deploy.
  The lab, both Try panels included, accepts up to 600,000 characters per text, so a long text scans
  as up to three segments; its quotes and results report the segment count.
  The Prompts workspace also has a **Test sets** tab beside Try. "Add to test set" on a Try result saves
  the text (re-composed on the server for an entity) with the verdict the moderator expects: an nsfw
  range or yes/no per flag, any of them left unscored. A run scores the production prompts (the
  baseline) and the moderator's draft against those expectations in the background and lists cases
  whose verdict flipped first. Sets, runs and results live in the moderator database
  (`apps/moderator/text-scan-test-sets/`); curating sets and cancelling another moderator's run need
  `textScan.testSets.edit`, running them only the workspace page.
- Errors are logged to Axiom under `name: 'text-scan'`; every submit also logs a `submitted` event.

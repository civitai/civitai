# Text Scan

One mechanism for scanning user-written text with an LLM and acting on the result. Each scan is a
single orchestrator `chatCompletion` step with a strict JSON schema; the verdict is recorded on
`EntityModeration` and handed to the entity's moderation adapter, which applies the action.

## Pieces

| piece                                                                    | where                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Scan profiles (which fields, which labels, the entity's declared state)  | `src/server/services/text-scan/profiles/`                   |
| Prompt storage (append-only table, cached; content is never in the repo) | `TextScanPrompt`, `text-scan/prompt.ts`                     |
| Model and input-size config                                              | sysRedis `system:text-scan:config`                          |
| Submit, dedup (`contentHash`), external id                               | `text-scan/submit.ts`                                       |
| Callback                                                                 | `/api/webhooks/text-scan-result`                            |
| Retry of failed scans                                                    | the `retry-failed-text-moderation` job (shared with XGuard) |
| Row retention                                                            | the `text-scan-retention` job                               |
| Actions per label                                                        | `text-scan/actions/` and each entity's moderation adapter   |

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
  attributed, audited moderator endpoint `/api/mod/text-scan` serves them. There, an API key that is
  not full-scope reaches only the read and caller-text scan actions (`getPrompts`, `quoteEntities`,
  `scanTexts`, `quoteTexts`); every other action, including any added
  later, refuses it. That endpoint also attributes prompt and config writes to the signed-in
  moderator.
- The moderator app's text-scan lab drives those actions: Check (`/text-scan/check`) judges links, ids
  or text with the current prompts and, side by side, with a moderator's edits, which are kept only in
  that moderator's browser; Versions (`/text-scan/prompts`) shows each prompt's history. It stores
  nothing in the moderator database. Publishing edits needs the `textScan.prompt.publish` permission,
  held by no one until granted on `/admin`; the pages are likewise unreachable until granted there.
  `/text-scan` and `/text-scan/playground` redirect to Check.
- Errors are logged to Axiom under `name: 'text-scan'`; every submit also logs a `submitted` event.

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
`src/server/services/text-scan/profiles/`. Crucible's scan (name, description → `nsfw`) replaces
XGuard. Collection's (name, description of Public collections readable as Public or Unlisted →
`nsfw`, a floor on the collection's rating) replaces Clavata.

## Actions

A label's action is one of: raise the content rating (the owner can dispute it), restrict the entity
(the owner can appeal), or mute the account pending moderator review. Disputes, appeals and mute
reviews go through the existing moderator queues; text scan adds no queue of its own.

## Modes

Each entity type has its own Flipt variant flag (`text-scan-<entity>`), evaluated per entity id:

- **off** — nothing is submitted.
- **shadow** — scans run and verdicts are written to a separate `<Entity>:shadow` row that nothing
  reads; no action runs.
- **active** — verdicts are written to the entity's row and actions run.

A verdict that arrives after the mode has left `active` is not written to the live row.

## Adding an entity or a label

1. A profile file under `profiles/`, imported by the barrel.
2. A prompt row for any new label, inserted through the harness's `putPrompt` (never in a migration).
3. An adapter with `applyTextScan`, registered in `moderation-adapters.ts`.
4. A flag, rolled out `off → shadow → active`.

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
  not full-scope reaches only the actions that return no entity text (`getPrompts`, `putPrompt`,
  `putConfig`, `quoteEntities`, `scanTexts`, `quoteTexts`); every other action, including any added
  later, refuses it. That endpoint also attributes prompt and config writes to the signed-in
  moderator.
- The moderator app's text-scan lab (`/text-scan/check`, `/text-scan/test-sets`, `/text-scan/prompts`
  labelled Versions with drafts and publish; `/text-scan/playground` redirects to Check) drives those
  actions. Its tables live in the moderator database and are applied by hand; see
  `apps/moderator/text-scan-lab/README.md`. Publishing a prompt needs the `textScan.prompt.publish`
  permission and editing test sets needs `textScan.testSet.edit`. Neither is held by anyone until
  granted on `/admin`, and the pages themselves are unreachable until granted there too.
- Errors are logged to Axiom under `name: 'text-scan'`; every submit also logs a `submitted` event.

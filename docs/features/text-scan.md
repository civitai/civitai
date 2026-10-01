# Text Scan

One mechanism for scanning user-written text with an LLM and acting on the result. Each scan is a
single orchestrator `chatCompletion` step with a strict JSON schema; the verdict is recorded on
`EntityModeration` and handed to the entity's moderation adapter, which applies the action.

## Pieces

| piece | where |
|---|---|
| Scan profiles (which fields, which labels, the entity's declared state) | `src/server/services/text-scan/profiles/` |
| Prompt storage (append-only table, cached; content is never in the repo) | `TextScanPrompt`, `text-scan/prompt.ts` |
| Model and input-size config | sysRedis `system:text-scan:config` |
| Submit, dedup (`contentHash`), external id | `text-scan/submit.ts` |
| Callback | `/api/webhooks/text-scan-result` |
| Retry of failed scans | the `retry-failed-text-moderation` job (shared with XGuard) |
| Row retention | the `text-scan-retention` job |
| Actions per label | `text-scan/actions/` and each entity's moderation adapter |

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
  scans it synchronously without recording it, prices it (`whatif`), or samples shadow verdicts for
  grading. Locally it is reached through `/api/testing/chat-completion-scan`; on deployed builds
  through the moderator endpoint `/api/mod/text-scan`, which attributes prompt and config writes to
  the signed-in moderator.
- Errors are logged to Axiom under `name: 'text-scan'`; every submit also logs a `submitted` event.

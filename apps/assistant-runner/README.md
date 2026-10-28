# apps/assistant-runner

Runs App Assistant replies on a server, so a reply keeps working while the viewer's page sleeps,
closes or loses its network. The page becomes a viewer: `<civitai-chat runner="remote">`
(`RemoteAgent` in `@civitai/components-chat`) starts a run, follows its events, reattaches to it from
any tab or device, and stops it.

**Status:** sign-in (civitai viewer tokens), run grants, the orchestration model, the
orchestration-backed conversation store, and App Assistant's tools and gate (the sandbox MCP tools,
`create_app`, `set_checklist`, `report_ready`, read-only subagents, the live preview) are real. App Assistant's page uses
it behind `appAssistantRemoteRunner` (dark until its Flipt flag turns it on). Without civitai's public
key configured the service refuses every run-API request (401); with it but without `SANDBOX_URL` it
refuses every start (403 `refused`, saying its tools are not set up) rather than reply with no tools.
See [Not built yet](#not-built-yet).

**Layout.** `src/core/` is the generic runner (the DBOS workflows, the run API, the journal, the head
and progress writes) and reaches the rest only through the seams in `src/core/interfaces.ts`; the
`core-boundary` test fails on any import from `src/core/` to outside it. Everything civitai's own
stays outside: viewer tokens and run grants (`tokens.ts`, `grants.ts`, `minter.ts`,
`credentials.ts`), orchestration (`orchestration*.ts`, `model-calls.ts`, `conversation-store.ts`),
App Assistant (`app-assistant/`, including the SDK pin), the Restart preview route (`app.ts`) and
`server.ts`, which wires them together. `reply-dbos-calls.pg.test.ts` pins the DBOS calls a reply
makes, which `WORKFLOW_VERSION` protects.

## How it works

- **Protocol.** It implements the run protocol of `@civitai/components-chat@0.32.0`, entry
  `@civitai/components-chat/runner-protocol`, protocol version `v: 1`:

  | Call                             | Answer                                                                                                                                                        |
  | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /runs`                     | `201` `StartRunResponse`, or `RunErrorResponse` (`run-active` 409, `stale-turn` 409, `bad-request` 400, `unauthorized` 401, `refused` 403, `unavailable` 503) |
  | `GET /runs?conversationId=`      | the conversation's live run with `lastEventId`, or `null`                                                                                                     |
  | `GET /runs/<runId>/events`       | SSE, `id:` the journal position; honours `Last-Event-ID`; a keep-alive comment every 10 s                                                                     |
  | `POST /runs/<runId>/stop`        | `202`; the run ends with `run-ended` `stopped`. `404` for a run that is not the viewer's                                                                      |
  | `POST /runs/stop`                | `202`; stops the run a start with that key started, or makes a later start with it end at once                                                                |
  | `POST /conversations/<id>/patch` | `204`; title or model written into the head. `404` for a chat the viewer does not have                                                                        |

  Plus `GET /healthz` (process up) and `GET /readyz` (DBOS launched), always at the root.

  Features (`src/core/protocol.ts`; `RUN_FEATURE_EDIT` in the package since 0.31.0): every start's
  and lookup's answer lists `features: ['edit']`, and a start may carry `turn.edit`: the
  user edited their latest message, so `turn.user` replaces the saved message of turn `seq` (the head's latest, or the next when the head ends just before it), the reply that
  followed it is dropped, and the turn is replied to afresh (nothing carries on from the old reply,
  and a chat named after its first message is named after the edited one). An edit is a new reply,
  charged as one. A page shows Edit only once a runner lists `edit`; it sends `edit` without
  `retry`, so a runner without this answers `stale-turn` instead of replying to the old message.
  A retry carries on only from a run that answered the message the turn holds now, and a retry
  carrying another message than the head holds is refused as `stale-turn`. Rolling back to
  a runner without this while an edit's run is queued and has not begun would reply to the edited
  message but keep the old one in the head (`WORKFLOW_VERSION` is unchanged).

- **Where it is served.** The run API lives under `RUNNER_BASE_PATH`, e.g. `/api/assistant-runner`,
  so the page reaches it on its own origin (its `remoteRunner.url`);
  routing that path to the runner is the deployment's job. Empty serves it at the root.
- **Sign-in.** Every run-API request carries a civitai **viewer token** in `Authorization: Bearer`:
  an ES256 JWT civitai signs for about 5 minutes (`GET /api/apps/assistant/runner-viewer-token`, a
  full-scope session). The runner verifies it with civitai's public key (signature, `iss`, `aud`,
  `typ`, `exp`, 30 s of clock skew) and reads nothing else: no cookie, no query string. Without the
  key every request is refused (401).
- **Run grants.** A start (`POST /runs`) also carries a **run grant** in `X-Run-Grant`: an ES256 JWT
  from `GET /api/apps/assistant/run-grant?conversationId=&idempotencyKey=` (a full-scope session and
  App Assistant consent), naming the viewer, the conversation and the start's idempotency key, for
  about 2 h 10 min (`ASSISTANT_RUNNER_GRANT_TTL_SECONDS`). The runner checks the conversation and key
  when it starts the run (and the conversation at a patch); the tokens the grant mints are the
  user's, user-wide, as the browser's are. A start whose grant is missing, expired, of
  another kind, or for another viewer, conversation or key is refused (403 `refused`). The page sets
  it per start from its `remoteRunner.fetch`, which sees the start's body. A
  `POST /conversations/<id>/patch` may carry a grant for that conversation (any key); without one it
  is written with a live run's grant, and a chat with neither is refused (403 `refused`).
- **Tokens, per request.** The runner keeps each run's grant in its own table
  (`assistant_runner.run_grants`, keyed by run id), never in a DBOS workflow input, step output or
  the journal. Each model or store request trades the grant, with the runner's own secret, at
  civitai's internal mint endpoint for a 5-minute App Assistant token of the purpose it needs
  (`chat` for the model and the store, `sandbox` for the sandbox service and its MCP server), inside
  that request's own fetch, and uses one token for a minute at most (and never in its last minute);
  a Stop stops waiting for a mint at once. On every mint civitai runs the same gates as the
  browser's token route (ban, onboarding, mute, email verification, the App Assistant flag), plus the runner's own
  flag `appAssistantRemoteRunner` (so turning it off ends runs already under way at their next
  model, store or sandbox request, within about a minute; a command already running in the sandbox
  is not stopped by it), on the
  user as its database has them now, then the consent check, so any of them going off ends a reply at
  its next request with a refusal that is never retried. A grant is deleted on every end the runner
  writes to the head, and when its workflow throws; an end it could not save after retries is kept
  with the grant and written by a repair pass every 30 s while the grant is live. The sweep deletes
  expired grants, and logs (by run id) any end that never got saved. If civitai cannot judge the
  gates just now (its session hub or Flipt is down), the mint answers `unavailable`, which is
  retried, never a refusal.
- **App Assistant's tools** (`src/app-assistant/`, with `SANDBOX_URL`):
  - **The sandbox.** As a reply starts, the runner looks up the app the page says is open
    (`page: { app }`, an app key, nothing else) among the user's own sandboxes, with the user's
    `sandbox` token, and wakes it when it is paused or starting (as the page does before a message:
    `openApp`, which pauses another app only when the service runs one at a time), waiting up to 3
    minutes for it to run. A key the user has no sandbox for opens nothing. Its MCP tools are offered as
    `sandbox__<tool>`, over Streamable HTTP to the sandbox's MCP address, which must be on the sandbox
    service's own origin (else the token is never sent and no tools are offered); each request carries a
    freshly minted `sandbox` token. A reply is cut to its first 2,000 and last 6,000 characters, and a
    call may go 610 s without progress: the chat's own MCP connection and added-server tool adapter
    (`createMcpConnection`, `extraToolSet` from `@civitai/components-chat/core` 0.32.0), so a lost
    reply stream is answered at once, as in the browser.
  - **Paused mid-reply.** The app is woken only as the reply starts. When a call is refused later
    (the connection cannot be opened, or the MCP address answers with an error status), the runner
    looks at the user's apps once and never makes the call again (it may have run before the refusal
    came back), never wakes the app, and so never pauses the one the user is on:
    - app paused, another app running (the user opened it): the reply ends as interrupted, "Paused:
      you opened another app", and the page offers Continue (which starts the app again);
    - app paused, nothing else running (30 idle minutes, the 8-hour cap): the same, saying it slept;
    - app still running (a proxy's 502), or starting again (a pod restart): the assistant is told the
      call may have finished, and the reply goes on;
    - app deleted: the call fails, telling the user to open it again.
    A reply ended this way keeps its saved steps, every call in them answered. Waking at the start makes
    no new app: if the service's open made a new, empty one (deleted meanwhile), the reply ends with an
    error. A call whose reply was lost (no progress for 610 s) is not made again either.
  - **The tunnel tools** (`tunnel_*`) are not offered to the assistant: the runner drives them itself,
    inside `start_preview` and `stop_preview`, so the assistant cannot point the sandbox at a host
    civitai did not open.
  - **Stop and the end of a reply close the MCP transport**, which aborts every request in flight:
    the only way to reach a `sandbox__run_command` still running in the sandbox.
  - **Save before run.** Every call, sandbox ones included, waits until the head save that records its
    start has landed (`runAfterSaved`), so a recovered run sends a finished call's result and closes a
    started one as interrupted, never running either again.
  - **The gate is App Assistant's own** (`@civitai/app-assistant`, the same code the page runs): 150
    parent calls per reply (a subagent's are not counted), then the reply ends with Continue;
    `report_ready` refused until, since the last file change or other command, the parent's
    `sandbox__preview_check`, test run and typecheck passed and every checklist item is done;
    `set_checklist` and `create_app` as on the page. What is verified, and the checklist, belong to the
    app: `create_app` opening another app starts both over, as the page does, and each checklist the
    runner shows records its app, so a later reply carries over only the open app's. A reply carried on
    from saved steps starts its count and checks from those steps; a new reply keeps the app's checklist
    but checks the app again (the page, unlike the runner, also keeps checks across the replies of one
    page load). Every finished call is journaled as `tool-reported` with what the page's own views read
    (a command, a result's first 200 characters, a page tool's result), never a file's contents.
  - **The prompt is App Assistant's**, the runner's variant from the same builders
    (`assistantSystemPrompt('remote', …)`, `buildAssistantInstructions({ runner: 'remote' })`): it names
    only tools the runner has (the setup guide read with `sandbox__run_command`, no raw tunnel tools, no guide tool
    for subagents, and none of the chat's own rules' sentences naming `ask_choice`, which waits for a
    viewer who may not be there), built from the sandbox it found, in place of the page's
    `hostInstructions`. A test checks every tool the whole system prompt names is offered.
  - **The live preview** (`src/app-assistant/preview.ts`, `dev-tunnel.ts`): `start_preview` and
    `stop_preview`, the page's names (so one prompt fits both), through the App Blocks dev tunnel, so
    the user's page and the assistant see the same running dev server (port 5173):
    1. `start_preview { block_id?, declared_scopes?, declared_auth? }` asks the sandbox for a fresh
       single-use key (`tunnel_key`, which returns only its public half), then civitai's
       `POST /api/internal/app-assistant/dev-tunnel/start` with the runner's secret and the run's
       grant (read from the grants table inside that request, as a mint is) opens the tunnel for the
       grant's user: civitai re-judges every gate there (App Assistant's, `appAssistantRemoteRunner`,
       `appBlocksAuthor`, the dev-tunnel flag, ownership of the block, the hourly start limit). The
       sandbox then dials the host civitai named, pinning the sish host key civitai gave
       (`tunnel_connect`). A refusal (403, 404, 429) or a failed connect is a tool error the
       assistant reads, and a tunnel civitai opened but the sandbox could not reach is closed again.
       No civitai credential reaches the sandbox, only its own key's host and host key, as in the
       browser.
    2. The result is `{ shown, blockId, host, next_step }`, journaled like every call as
       `tool-reported`. The page reads `blockId` and `host` from it and (re)fetches
       `/api/apps/assistant/preview?blockId=`, which finds the user's live tunnel by itself. The
       tunnel's id never leaves the run's memory: not in a result, the journal, the head or DBOS.
    3. While the run lives, the runner calls civitai's `keepalive` every 5 minutes (civitai's idle
       window is 30; a failed call is retried at the next tick, and each one re-judges the gates)
       for the open app's preview, whoever opened it: this run, an earlier reply, or the page's
       Restart preview. It names the host the app's sandbox is connected to (`tunnel_status`), and
       civitai keeps the grant's user's tunnel at that host, never another user's; a sandbox with
       no tunnel running (paused, disconnected) keeps nothing alive. A `NOT_FOUND` is asked again
       at the next tick; a refusal or dead grant stops it, and so does `stop_preview` until the
       next start. Each tick's `tunnel_status` request is activity for the app too, so a live run
       also keeps its app from pausing as idle. When the run ends it stops keeping the tunnel alive and civitai's normal idle expiry
       applies, so the user keeps the preview for a while. The 8-hour cap never moves.
    4. `stop_preview` closes the run's own tunnel at civitai (`stop`) and the sandbox's side
       (`tunnel_disconnect`); a preview an earlier reply started is closed from the sandbox's side
       and idles out at civitai.
    5. **It opens by itself.** When a `sandbox__dev_server_start` or `sandbox__dev_server_restart`
       call succeeds (its status says the server runs) and the preview is set up here, the runner runs the steps above for the
       open app, once per app per run, with no decision of the assistant's: the block id, scopes
       and auth come from the project's `block.manifest.json` (the directory the start command
       `cd`s into, or, for a restart with no command, the one its status says it ran; else the
       app's own key). The page is told by the same `tool-reported`
       `start_preview` result, and the assistant reads, after the dev server's own answer, that the
       user now sees the preview, or why it could not open (a refusal never fails the dev
       server's start, and is not tried again in the run). A `start_preview` for the same app and
       block, asking for no other scopes or auth than it was opened with, then answers the same
       preview without asking civitai again (other scopes or auth open it again with them). In production a model
       had started the dev server, checked the app and reported it ready without ever calling
       `start_preview`.
    A later reply (or Continue after the app was paused) starts or restarts the dev server, which
    opens the preview again; civitai replaces the user's tunnel for that block. The instructions say the
    preview opens by itself, keep `start_preview` for when the user asks to reopen it, and tell
    the assistant to start the dev server first and to use `sandbox__preview_check` (with
    `screenshot: true` when the look matters) to see what the user sees. The screenshot reaches the
    model through the chat package (0.28.0 and later): `extraToolSet` keeps an MCP result's image
    for `AgentCore`, which shows it once, in a user message right after that step's tool results;
    the saved conversation keeps only a one-line note in its place. A model that takes no images
    is asked for that step again without them. The instructions still tell the assistant to go by
    the text when no image comes back and never to describe a picture it did not receive.
  - **Subagents:** read-only subagents (`dispatch_agent`, the page's allowlist and instructions) when the
    run grant says the viewer has `appAssistantSubagents` (civitai signs `subagents: true` into it; the
    page's word is not taken). Their progress is journaled as `subagent-progress`.
  - Not offered: the orchestration and site MCP tools (`fetch_page`, `get_guide`, …) the browser's chat
    adds itself.
- **The model** is orchestration's OpenAI-compatible `POST /v1/chat/completions`
  (`ORCHESTRATION_URL`), asked as the browser's App Assistant asks it: the chat package's provider
  name and options, the viewer's own `chat` token (so orchestration bills the viewer under the App
  Assistant's client and its daily Buzz cap), and `X-Civitai-Tier: free` while the viewer's free
  allowance for the model lasts, as their `tier` setting allows. `RUN_MAX_STEPS` and
  `RUN_CONTEXT_BUDGET_TOKENS` match App Assistant's page (1000 steps, 64 000 tokens).
- **The conversation store** is where the browser keeps it: orchestration `echo` workflows tagged
  `cvt:head`, one per turn, the conversation in the workflow's metadata, read and written exactly as
  the chat's `ThreadStore` does (the same tags, `externalId` and v2/v3 format), as the viewer. So a
  chat started on the runner opens in the browser, and one started in the browser carries on here.
  A write holds a Postgres advisory lock for its conversation, so two replicas never lose each
  other's change.

- **One DBOS workflow per reply** ([DBOS Transact](https://docs.dbos.dev), Postgres only). The
  workflow id is the run id, derived from the viewer and the start's idempotency key, so a retried
  start returns the same run. Its `pass` step runs `AgentCore` from `@civitai/components-chat/core`
  unchanged.
- **The journal** is a DBOS stream (`writeStream` / `readStream`) on the run's workflow; an event's
  SSE id is its stream offset. Text is sent as deltas (`createPartsDiffer`), batched about every
  100 ms, never as whole parts.
- **One active run per user.** Runs go on the `replies` queue with the user id as DBOS's
  deduplication id, so two starts that race cannot both enqueue. A start while the user has a live
  run is refused `run-active`.
- **Stop** sends the run a DBOS message. The workflow receives it while its `pass` step runs,
  aborts `AgentCore`, closes the tool transports, saves the head and journals `run-ended`
  `stopped`. If the run has not ended `RUN_STOP_GRACE_MS` later, its workflow is cancelled
  outright. A run cancelled that way, timed out by DBOS or past its recovery limit cannot journal
  its own end, so the first reader of its stream writes that end to the head (once) and the stream
  ends with a `run-ended` built from the head. Each process checks its running passes every 2 s (one query for all of them) and stops any whose workflow was cancelled outright, as a graceful Stop would. Once a reply's end is in the head, a pass finishing later cannot replace it.
- **Wall clock.** A run ends `ran_out` after `RUN_WALL_CLOCK_MS` (2 h by default). DBOS's own
  workflow timeout, a minute later, is the backstop.
- **Crash recovery.** A restarted process with the same `RUNNER_EXECUTOR_ID` recovers the runs it
  held. The `pass` step runs again from the reply's last saved progress: a tool call that finished
  is sent with its result and a call that started and did not finish gets the chat's "interrupted"
  result, so neither runs again (`src/__tests__/recovery.pg.test.ts` kills a runner mid-tool to
  check this). A tool call waits to run until the head save that records its start has landed, and
  fails without running if that save does not land. A pass that already saved the reply's end
  (or journaled `run-ended`) before it died does not run again: it journals that end and returns.
  DBOS recovers one run at most 5 times.
- **A model call cut by a crash is not paid twice.** Orchestration names each chat completion's
  workflow in its `X-Civitai-Workflow-Id` response header, before the answer streams. The runner
  keeps it at once, before reading the answer, in its own table (`assistant_runner.model_calls`:
  run id, user, conversation, turn, a hash of what the request asks, the workflow id; no
  credential), since a DBOS step's output is saved only when the step ends and the whole reply is
  one step. A request asked again with the same key (the step recovered after a crash, or a
  Continue) first reads that workflow (`GET /v2/consumer/workflows/{id}`), reading it again through
  up to three failed reads in a row: succeeded, its stored answer is the request's, with no new
  request; still running, it is waited for until it ends or the run stops waiting (its wall clock,
  a Stop), which cancels it; failed, expired, cancelled or holding nothing a step can be rebuilt
  from, the request is sent again (after cancelling the workflow when its state cannot be read). A
  retry that carries on from at least one step an earlier run saved (Continue) may take that run's
  answer too; a retry carrying no saved step (a regenerate) never does. A model call cut off by the
  run (Stop, the wall clock, a pause, a cancel outright) has its workflow cancelled
  (`PUT /v2/consumer/workflows/{id}`, `{"status":"canceled"}`), which stops the model and its
  billing; the pass's end waits up to 2 s for that. Each branch is logged with the workflow id
  under `modelCall` (`reused`, `waiting`, `asked-again` with its `reason`, `cancelled`). The key
  leaves out the system prompt (it names the date). Rows are deleted with the runs' retention.
- **Runs left on an old version.** DBOS recovers a run only in a process of the same
  `WORKFLOW_VERSION` (`src/core/runner.ts`). At start and every 10 minutes, a runner cancels the runs its
  own executor id holds under another version and saves each reply as interrupted, keeping its
  finished steps: the user's slot frees and the page offers Continue, which carries on from those
  steps. A replica touches only its own executor id, so a run another replica still holds is never
  ended this way.
- **Retention.** Every 10 minutes, a runner deletes the workflows, journals and stop markers of
  runs that ended more than `RUN_RETENTION_DAYS` ago (default 7), up to 500 at a time. DBOS 5.3 has
  no retention setting of its own; this uses its `listWorkflows` and `deleteWorkflows`.
- **Shutdown.** On SIGTERM the runner stops taking requests, gives runs in flight up to
  `RUN_SHUTDOWN_GRACE_MS` to finish (the check for runs cancelled outright keeps running meanwhile),
  and exits; the rest resume when a process with the same executor id starts. A workflow that
  throws its own error (before launch finished, or while the drain lasts) ends ERROR, which DBOS
  never recovers, so its end is written to the head then. Nothing is written for a hard cancel or
  the deadline sweep (reported here as a cancel: the reply's `finally` sends to the workflow, and
  DBOS 5.3's send checks for a cancel first), for a conflict (an ownership hand-off with no cancel,
  as a recovery re-enqueue, or a cancel during `begin`; the executor keeps the recorded outcome),
  for the recovery limit, or for anything thrown once the drain is over (the executor gone; the run
  stays PENDING for the next process). Each has its own path, and an end written then would
  replace the real one (a kept end waiting for repair, Stop's aborted end, a ran-out end). One
  window remains: a hard cancel landing between a reply keeping its end for repair and journaling
  `run-ended`, while a client reads the stream, lets the end from the head (or Stop's forced end)
  write over the kept end and drop the grant.
- **The head.** In remote mode the runner is the only writer of the saved conversation. It saves
  the user's turn as the run starts, the reply's progress as a v3 head (`running`) as each call
  starts and lands, and how the reply ended (v2) before `run-ended`, in the format the chat package
  reads (`turnFrom`, `conversationMetadataOf`). The turn records the run that owns it (`runId`, a field
  the chat's reader ignores): the latest run started for it, a retry included. Only its owner writes
  its progress or its end, so a late end of an older run (written by a stale reader of its stream)
  never lands on a newer retry of the turn, and a run recovered after a retry took its turn over ends
  without writing to it (and its grant goes). A turn with no owner is written as before (any run of
  it may): one saved before owners were, and any turn the browser runner saved since, because its
  `ThreadStore` rebuilds turns through `turnFrom` and drops the owner (switching modes fails open).
- **Credentials.** DBOS persists every workflow input, step output and stream value. The runner
  hands its workflows and providers a user id and a run id only: no request header, grant, token or
  cookie goes into a workflow argument, a step output, the journal, the head or the model calls'
  table (workflow ids only), and tests scan the DBOS tables for the credentials sent with a start
  and for a token minted during the run. Request
  headers are never logged.

## Threat model

- **What each credential can do.** A viewer token reads and stops the viewer's own runs, and with
  a grant starts one, for about 5 minutes. A run grant mints user-wide App Assistant tokens for one
  user, and only together with the runner's secret, until it expires; it starts nothing by itself. A minted
  token is the same 5-minute App Assistant token the browser gets today.
- **The runner's database alone mints nothing**: it holds grants but not the runner's secret.
- **The runner's secret alone mints nothing**: civitai mints only for a grant it signed.
- **Database and secret together** mint, for live grants only, until each expires (2 h 10 min at
  most), and only while the user passes App Assistant's gates and consent.
- **The runner cannot forge** a viewer token or a grant: it holds civitai's public key only. The two
  kinds have distinct `aud` and `typ`, so neither passes as the other.
- **A cookie never reaches the runner as a credential**: it reads the `Authorization` and
  `X-Run-Grant` headers only, and logs neither.
- **Revocation.** Revoking App Assistant's consent, a ban, a mute, a lost email verification or the
  feature flag going off stops every mint at once; a run in flight ends at its next model or store
  request.


## Environment

See [`.env.example`](./.env.example).

| Variable                    | Default                   |                                                                                                                                          |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | (required)                | The runner's own Postgres database. DBOS creates its `dbos` schema there.                                                                |
| `RUNNER_EXECUTOR_ID`        | `local`                   | Stable and distinct per replica (a StatefulSet pod name). Required in production: two processes with one id would recover the same runs. |
| `RUN_WALL_CLOCK_MS`         | `7200000`                 | The longest one run may take.                                                                                                            |
| `RUN_STOP_GRACE_MS`         | `5000`                    | How long a Stop waits before cancelling the run outright.                                                                                |
| `RUN_WORKER_CONCURRENCY`    | `50`                      | Runs one process works on at once.                                                                                                       |
| `RUN_RETENTION_DAYS`        | `7`                       | Ended runs are deleted after this many days.                                                                                             |
| `RUN_SHUTDOWN_GRACE_MS`     | `10000`                   | On SIGTERM, how long runs in flight get to finish.                                                                                       |
| `RUNNER_BASE_PATH`          | (empty)                   | The path the run API is served under, e.g. `/api/assistant-runner`.                                                                      |
| `RUNNER_TOKEN_PUBLIC_KEY`   | (unset)                   | civitai's ES256 public key (SPKI PEM). Unset: every run-API request is refused. Set: the three below are required.                       |
| `RUNNER_SECRET`             |                           | The runner's own secret for civitai's mint endpoint (civitai's `ASSISTANT_RUNNER_SECRET`).                                               |
| `CIVITAI_URL`               |                           | civitai's base URL, where grants are traded for tokens.                                                                                  |
| `ORCHESTRATION_URL`         |                           | Orchestration's base URL: the model and the conversation store.                                                                          |
| `SANDBOX_URL`               | (unset)                   | The hosted sandbox service (civitai's `APP_ASSISTANT_SANDBOX_URL`): App Assistant's tools. Unset (with civitai configured): starts are refused. |
| `RUN_MAX_STEPS`             | `1000`                    | The most model requests one reply takes.                                                                                                 |
| `RUN_CONTEXT_BUDGET_TOKENS` | `64000`                   | About how many tokens of earlier conversation a reply sends.                                                                             |
| `PORT`, `HOST`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `info` |                                                                                                                                          |

## Run it locally

Against any Postgres you can create a database on:

```bash
createdb assistant_runner
cp apps/assistant-runner/.env.example apps/assistant-runner/.env   # set DATABASE_URL
pnpm --filter @civitai/assistant-runner-app dev
curl localhost:3000/readyz
```

Every run-API call answers 401 until `RUNNER_TOKEN_PUBLIC_KEY` (and the rest of that group) is set.

```bash
pnpm --filter @civitai/assistant-runner-app typecheck
pnpm --filter @civitai/assistant-runner-app build      # tsup → dist/server.js
pnpm --filter @civitai/assistant-runner-app test
```

The `*.pg.test.ts` suites need `ASSISTANT_RUNNER_TEST_DATABASE_URL`, a Postgres server they may
create and drop databases on; without it they skip. CI's `App unit tests` job provides one.

## Not built yet

- The route from the page's origin (`/api/assistant-runner`) to the runner: the deployment's job.
- The orchestration and site MCP tools the browser's chat adds (`fetch_page`, `get_guide`, …).

Known gaps:

- The page learns of a runner's preview only from the live `tool-reported` event, which a reload
  or another device does not replay: the pane then shows nothing until a later reply starts or
  restarts the dev server, or the user asks to reopen it and the assistant calls `start_preview`
  (the instructions keep it for that), or the user clicks the pane's Restart preview
  (`POST apps/:app/preview`, no reply and no Buzz; `src/app-assistant/preview-restart.ts`), which
  first starts the dev server when it is not running, as after every pause. Asking civitai's
  preview route on load was tried and dropped: civitai keeps a tunnel's record up to its idle
  window after the sandbox side is gone (a pause, a `stop_preview` of an earlier reply's
  preview), so it would show a dead preview.
- A run recovered after a crash has lost its preview's tunnel id (it is kept in memory only); it
  still keeps the app's preview alive by its host, but `stop_preview` then closes only the
  sandbox's side, and civitai's side idles out.

- A model call cut by a crash is not streamed again: once its workflow ends, its whole answer
  arrives at once (orchestration has no reattach to a stream in flight). One cut before
  orchestration answered with its workflow id (while it set the workflow up) is still sent, and
  paid, again. A request whose saved steps rebuild into a different request body (a different key)
  is sent again too.
- The stop fallback's timer lives in the process that took the Stop; if that process dies first, the
  run is not cancelled outright (it still ends on its own Stop or its wall clock).
- Journal reads poll Postgres; their load per viewer has not been measured.
- A run left by a replica that was removed (its executor id never comes back) holds its user's
  slot until DBOS's workflow timeout cancels it, or until the user stops it.
- A run ends `ran_out` two minutes before its grant expires, if that comes before its wall clock (a
  run that waited long in the queue, or was recovered late), so it can still save its end.

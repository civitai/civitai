# apps/assistant-runner

Runs App Assistant replies on a server, so a reply keeps working while the viewer's page sleeps,
closes or loses its network. The page becomes a viewer: `<civitai-chat runner="remote">`
(`RemoteAgent` in `@civitai/components-chat`) starts a run, follows its events, reattaches to it from
any tab or device, and stops it.

**Status:** sign-in (civitai viewer tokens), run grants, the orchestration model and the
orchestration-backed conversation store are real. A reply has no tools yet (words only): the
sandbox tools and the App Assistant gate come next. Without civitai's public key configured the
service refuses every run-API request (401). See [Not built yet](#not-built-yet).

## How it works

- **Protocol.** It implements the run protocol of `@civitai/components-chat@0.21.0`, entry
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
  App Assistant consent), bound to the viewer, the conversation and the start's idempotency key, for
  about 2 h 10 min (`ASSISTANT_RUNNER_GRANT_TTL_SECONDS`). A start whose grant is missing, expired, of
  another kind, or for another viewer, conversation or key is refused (403 `refused`). The page sets
  it per start from its `remoteRunner.fetch`, which sees the start's body. A
  `POST /conversations/<id>/patch` may carry a grant for that conversation (any key); without one it
  is written with a live run's grant, and a chat with neither is refused (403 `refused`).
- **Tokens, per request.** The runner keeps each run's grant in its own table
  (`assistant_runner.run_grants`, keyed by run id), never in a DBOS workflow input, step output or
  the journal. Each model or store request trades the grant, with the runner's own secret, at
  civitai's internal mint endpoint for a 5-minute App Assistant token of the purpose it needs
  (`chat`), inside that request's own fetch, and keeps it in memory until a minute before it
  expires. civitai re-checks the user's App Assistant consent on every mint, so turning the
  assistant off stops a reply at its next request. A grant is deleted when its run ends by itself;
  the maintenance sweep deletes expired ones and those of runs that ended any other way.
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
- **Runs left on an old version.** DBOS recovers a run only in a process of the same
  `WORKFLOW_VERSION` (`src/runner.ts`). At start and every 10 minutes, a runner cancels the runs its
  own executor id holds under another version and saves each reply as interrupted, keeping its
  finished steps: the user's slot frees and the page offers Continue, which carries on from those
  steps. A replica touches only its own executor id, so a run another replica still holds is never
  ended this way.
- **Retention.** Every 10 minutes, a runner deletes the workflows, journals and stop markers of
  runs that ended more than `RUN_RETENTION_DAYS` ago (default 7), up to 500 at a time. DBOS 5.3 has
  no retention setting of its own; this uses its `listWorkflows` and `deleteWorkflows`.
- **Shutdown.** On SIGTERM the runner stops taking requests, gives runs in flight up to
  `RUN_SHUTDOWN_GRACE_MS` to finish, and exits; the rest resume when a process with the same
  executor id starts.
- **The head.** In remote mode the runner is the only writer of the saved conversation. It saves
  the user's turn as the run starts, the reply's progress as a v3 head (`running`) as each call
  starts and lands, and how the reply ended (v2) before `run-ended`, in the format the chat package
  reads (`turnFrom`, `conversationMetadataOf`).
- **Credentials.** DBOS persists every workflow input, step output and stream value. The runner
  hands its workflows and providers a user id and a run id only: no request header, grant, token or
  cookie goes into a workflow argument, a step output, the journal or the head, and tests scan the
  DBOS tables for the credentials sent with a start and for a token minted during the run. Request
  headers are never logged.

## Threat model

- **What each credential can do.** A viewer token reads and stops the viewer's own runs, and with
  a grant starts one, for about 5 minutes. A run grant mints App Assistant tokens for one user, and
  only together with the runner's secret, until it expires; it starts nothing by itself. A minted
  token is the same 5-minute App Assistant token the browser gets today.
- **The runner's database alone mints nothing**: it holds grants but not the runner's secret.
- **The runner's secret alone mints nothing**: civitai mints only for a grant it signed.
- **Database and secret together** mint, for live grants only, until each expires (2 h 10 min at
  most), and only while the user's App Assistant consent stands; civitai rate-limits mints per grant.
- **The runner cannot forge** a viewer token or a grant: it holds civitai's public key only. The two
  kinds have distinct `aud` and `typ`, so neither passes as the other.
- **A cookie never reaches the runner as a credential**: it reads the `Authorization` and
  `X-Run-Grant` headers only, and logs neither.
- **Revocation.** Revoking App Assistant's consent under connected apps stops every mint at once; a
  run in flight ends at its next model or store request. A ban or the feature flag going off does not
  (see the known gaps).


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

- The real `ToolProvider`: the sandbox MCP tools (with `sandbox` tokens from the same grant), with
  Stop closing the transport. Until then a configured runner gives a reply no tools.
- The App Assistant gate on the server (`set_checklist`, `report_ready`, `create_app`, the tool-call
  cap) and its `tool-reported` events.
- The page side: App Assistant's opt-in to `runner="remote"`, fetching viewer tokens and a grant per
  start, and the route from the page's origin to the runner.

Known gaps:

- A model step cut by a crash is asked for again (and paid again) until orchestration can reattach
  to a step in flight.
- The stop fallback's timer lives in the process that took the Stop; if that process dies first, the
  run is not cancelled outright (it still ends on its own Stop or its wall clock).
- Journal reads poll Postgres; their load per viewer has not been measured.
- A run left by a replica that was removed (its executor id never comes back) holds its user's
  slot until DBOS's workflow timeout cancels it, or until the user stops it.
- A run ends `ran_out` two minutes before its grant expires, if that comes before its wall clock (a
  run that waited long in the queue, or was recovered late), so it can still save its end.
- A ban or a lost feature flag does not stop a run in flight: the mint endpoint re-checks consent
  only, not the gates the grant endpoint checks.

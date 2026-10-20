# apps/assistant-runner

Runs App Assistant replies on a server, so a reply keeps working while the viewer's page sleeps,
closes or loses its network. The page becomes a viewer: `<civitai-chat runner="remote">`
(`RemoteAgent` in `@civitai/components-chat`) starts a run, follows its events, reattaches to it from
any tab or device, and stops it.

**Status:** the runner core. The model, the tools, sign-in and the conversation store sit behind
interfaces with fakes for tests; until a real authenticator is configured the service refuses every
run-API request (401). See [Not built yet](#not-built-yet).

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

  Plus `GET /healthz` (process up) and `GET /readyz` (DBOS launched).

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
  ends with a `run-ended` built from the head. Cancelling a workflow does not interrupt a pass still
  running in a live process; only the graceful Stop does.
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
  hands its workflows and providers a user id only: no request header, token or cookie goes into a
  workflow argument, a step output, the journal or the head, and a test scans the DBOS tables for
  a credential sent with the requests. A provider that needs a token must mint it inside its own
  fetch, per request. Request headers are never logged.

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
| `PORT`, `HOST`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `info` |                                                                                                                                          |

## Run it locally

Against any Postgres you can create a database on:

```bash
createdb assistant_runner
cp apps/assistant-runner/.env.example apps/assistant-runner/.env   # set DATABASE_URL
pnpm --filter @civitai/assistant-runner-app dev
curl localhost:3000/readyz
```

Every run-API call answers 401 until an authenticator is configured.

```bash
pnpm --filter @civitai/assistant-runner-app typecheck
pnpm --filter @civitai/assistant-runner-app build      # tsup → dist/server.js
pnpm --filter @civitai/assistant-runner-app test
```

The `*.pg.test.ts` suites need `ASSISTANT_RUNNER_TEST_DATABASE_URL`, a Postgres server they may
create and drop databases on; without it they skip. CI's `App unit tests` job provides one.

## Not built yet

- The real `Authenticator` (the viewer's civitai sign-in) and CORS or same-origin routing for the page.
- The real `ModelProvider`: orchestration's chat completions, billed to the viewer, with a short
  token minted per request inside the provider's fetch.
- The real `ToolProvider`: the sandbox MCP tools, with Stop closing the transport.
- The App Assistant gate on the server (`set_checklist`, `report_ready`, `create_app`, the tool-call
  cap) and its `tool-reported` events.
- The real `ConversationStore` (the orchestrator-backed head the page reads), with concurrent writers
  handled by the store.

Known gaps:

- A model step cut by a crash is asked for again (and paid again) until orchestration can reattach
  to a step in flight.
- The stop fallback's timer lives in the process that took the Stop; if that process dies first, the
  run is not cancelled outright (it still ends on its own Stop or its wall clock).
- Journal reads poll Postgres; their load per viewer has not been measured.
- A run left by a replica that was removed (its executor id never comes back) holds its user's
  slot until DBOS's workflow timeout cancels it, or until the user stops it.

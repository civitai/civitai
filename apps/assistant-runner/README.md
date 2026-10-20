# apps/assistant-runner

Runs App Assistant replies on a server, so a reply keeps working while the viewer's page sleeps,
closes or loses its network. The page becomes a viewer: `<civitai-chat runner="remote">`
(`RemoteAgent` in `@civitai/components-chat`) starts a run, follows its events, reattaches to it from
any tab or device, and stops it.

**Status: PR A, the runner core.** The model, the tools, sign-in and the conversation store sit
behind interfaces with fakes for tests. The service as built refuses every run-API request (401)
until PR B configures a real authenticator; see [What PR B adds](#what-pr-b-adds).

## How it works

- **Protocol.** It implements the run protocol of `@civitai/components-chat@0.21.0`, entry
  `@civitai/components-chat/runner-protocol`, protocol version `v: 1`:

  | Call                             | Answer                                                                                                                      |
  | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | `POST /runs`                     | `201` `StartRunResponse`, or `RunErrorResponse` (`run-active` 409, `stale-turn` 409, `bad-request` 400, `unauthorized` 401) |
  | `GET /runs?conversationId=`      | the conversation's live run with `lastEventId`, or `null`                                                                   |
  | `GET /runs/<runId>/events`       | SSE, `id:` the journal position; honours `Last-Event-ID`; a keep-alive comment every 10 s                                   |
  | `POST /runs/<runId>/stop`        | `202`; the run ends with `run-ended` `stopped`                                                                              |
  | `POST /runs/stop`                | `202`; stops the run a start with that key started, or makes a later start with it end at once                              |
  | `POST /conversations/<id>/patch` | `204`; title or model written into the head                                                                                 |

  Plus `GET /healthz` (process up) and `GET /readyz` (DBOS launched).

- **One DBOS workflow per reply** ([DBOS Transact](https://docs.dbos.dev), Postgres only). The
  workflow id is the run id, derived from the viewer and the start's idempotency key, so a retried
  start returns the same run. Its `pass` step runs `AgentCore` from `@civitai/components-chat/core`
  unchanged.
- **The journal** is a DBOS stream (`writeStream` / `readStream`) on the run's workflow; an event's
  SSE id is its stream offset. Text is sent as deltas, at most one batch per 100 ms
  (`createPartsDiffer`), never as whole parts.
- **One active run per user.** Runs go on the `replies` queue, partitioned by user with a
  partition concurrency of 1. A start while the user has a live run is refused `run-active`.
- **Stop** sends the run a DBOS message. The workflow receives it while its `pass` step runs,
  aborts `AgentCore`, closes the tool transports, saves the head and journals `run-ended`
  `stopped`. If the run has not ended `RUN_STOP_GRACE_MS` later, it is cancelled outright; a
  cancelled run cannot journal its own end, so the event stream then ends with a `run-ended` built
  from the saved head.
- **Wall clock.** A run ends `ran_out` after `RUN_WALL_CLOCK_MS` (2 h by default). DBOS's own
  workflow timeout, a minute later, is the backstop.
- **Crash recovery.** A restarted process with the same `RUNNER_EXECUTOR_ID` recovers the runs it
  held. The `pass` step runs again from the reply's last saved progress: a tool call that finished
  is sent with its result and a call that started and did not finish gets the chat's "interrupted"
  result, so neither runs again (`src/__tests__/recovery.pg.test.ts` kills a runner mid-tool to
  check this). The one gap is the browser runner's too: a call that started in the moment before
  its start was saved.
- **The head.** In remote mode the runner is the only writer of the saved conversation. It saves
  the user's turn as the run starts, the reply's progress as a v3 head (`running`) as each call
  starts and lands, and how the reply ended (v2) before `run-ended`, in the format the chat package
  reads (`turnFrom`, `conversationMetadataOf`).
- **Credentials.** DBOS persists every workflow input, step output and stream value. The runner
  hands its workflows and providers a user id only: no request header, token or cookie goes into a
  workflow argument, a step output, the journal or the head, and a test scans the DBOS tables for
  a credential sent with the requests. A provider that needs a token mints it inside its own fetch,
  per request. Request headers are never logged.

## Environment

See [`.env.example`](./.env.example).

| Variable                    | Default                   |                                                                                                                                          |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | (required)                | The runner's own Postgres database. DBOS creates its `dbos` schema there.                                                                |
| `RUNNER_EXECUTOR_ID`        | `local`                   | Stable and distinct per replica (a StatefulSet pod name). Required in production: two processes with one id would recover the same runs. |
| `RUN_WALL_CLOCK_MS`         | `7200000`                 | The longest one run may take.                                                                                                            |
| `RUN_STOP_GRACE_MS`         | `5000`                    | How long a Stop waits before cancelling the run outright.                                                                                |
| `RUN_WORKER_CONCURRENCY`    | `50`                      | Runs one process works on at once.                                                                                                       |
| `PORT`, `HOST`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `info` |                                                                                                                                          |

## Run it locally

Against any Postgres you can create a database on:

```bash
createdb assistant_runner
cp apps/assistant-runner/.env.example apps/assistant-runner/.env   # set DATABASE_URL
pnpm --filter @civitai/assistant-runner-app dev
curl localhost:3000/readyz
```

Every run-API call answers 401 until an authenticator is configured (PR B).

```bash
pnpm --filter @civitai/assistant-runner-app typecheck
pnpm --filter @civitai/assistant-runner-app build      # tsup → dist/server.js
pnpm --filter @civitai/assistant-runner-app test
```

The `*.pg.test.ts` suites need `ASSISTANT_RUNNER_TEST_DATABASE_URL`, a Postgres server they may
create and drop databases on; without it they skip. CI's `App unit tests` job provides one.

## What PR B adds

- The real `Authenticator` (the viewer's civitai sign-in) and CORS or same-origin routing for the page.
- The real `ModelProvider`: orchestration's chat completions, billed to the viewer, with a short
  token minted per request inside the provider's fetch.
- The real `ToolProvider`: the sandbox MCP tools, with Stop closing the transport.
- The App Assistant gate on the server (`set_checklist`, `report_ready`, `create_app`, the tool-call
  cap) and its `tool-reported` events.
- The real `ConversationStore` (the orchestrator-backed head the page reads), with concurrent writers
  handled by the store.

## Not covered yet

- A model step cut by a crash is asked for again (and paid again) until orchestration can reattach
  to a step in flight.
- The stop fallback's timer lives in the process that took the Stop; if that process dies first, the
  run is not cancelled outright (it still ends on its own Stop or its wall clock).
- Journal reads poll Postgres; their load per viewer has not been measured.

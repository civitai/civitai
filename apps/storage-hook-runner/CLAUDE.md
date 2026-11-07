# apps/storage-hook-runner

**The contract lives in [`README.md`](./README.md)**: the signed `POST /v1/check` request and
response, every refusal cause, the status codes the caller maps to `hook_unavailable`, and the
isolation and limits table. Read it before changing behaviour, and change it with the code.

This app evaluates App Storage permission hooks: untrusted author JavaScript, run in a QuickJS
WASM sandbox inside a pool of `worker_threads`. It is a standalone Node service, not a SvelteKit
app, so `docs/svelte-app-standard.md` does not apply.

## Non-negotiables

- **No capability reaches hook code.** No host function is registered, there is no module
  loader, and input and output cross as JSON strings parsed and serialised inside the VM. Adding
  any host function is a security change, not a feature.
- **Fail closed.** A runner fault (a worker crash, a failed dispose, the backstop) answers 500 and
  never returns an answer computed by the faulted call. Never turn a runner fault into an
  author-fault refusal, or the reverse.
- **Every bound lives in `src/limits.ts`.** The README's limits table is written from it; change
  both together.
- **Worker-loaded files use erasable TypeScript only** and import siblings with an explicit `.ts`
  extension: Node strips their types itself under test (see `tsconfig.json`).
- **Timing tests assert lower bounds tightly and upper bounds loosely** (well under the
  backstop), so CI load cannot turn them red.

## Commands

`pnpm --filter @civitai/storage-hook-runner-app typecheck` (and `test`). From the root,
`pnpm dev:storage-hook-runner` starts it; it needs `STORAGE_HOOK_RUNNER_SECRET` (32+ chars).

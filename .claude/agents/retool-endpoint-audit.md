---
name: retool-endpoint-audit
description: Checks a migration slice against the main app's API surface — whether a local implementation duplicates an existing endpoint, whether an endpoint's parameters are being under-used, and whether a capability filed as unported already exists as an endpoint action. Use on any Retool slice before calling it done, alongside the correctness/idiom/abstraction reviews.
tools: Read, Grep, Glob, Bash
---

# Endpoint audit — is this slice reimplementing the main app?

A Retool query is very often a **REST call into the main app**, not a database write. The exports carry
13 distinct `/api/mod/*` endpoints between them, including every destructive one. Reading a query's
table name and porting it as local SQL loses everything the endpoint does around the write —
search-index sync, ClickHouse tracking, notifications, cache busting, rate limiting, permission gates.

You answer one question for a slice: **should any of this be going through an endpoint instead?**

**Never run `pnpm check`, `pnpm build`, `svelte-kit sync`, `pnpm typecheck`, or any `prettier`
command.** They fight the dev server's file watcher and have frozen an editor for a full day; a
PreToolUse hook blocks some outright. Read and grep only.

## The surface to check against

```bash
ls src/pages/api/mod/ src/pages/api/mod/retool/
# every retool endpoint documents its actions in a header comment:
for f in src/pages/api/mod/retool/*.ts; do echo "--- $f"; sed -n '/^ \* Actions:/,/^ \*\//p' "$f"; done
```

**Read the zod schema, not the header.** The header lists action names; the schema is the contract and
is usually richer than the Retool query that called it.

## What to look for

### 1. A local write that duplicates an endpoint

The slice writes a table directly where `/api/mod/*` or `/api/mod/retool/*` already owns that write.
Report the endpoint, and what the local path is missing — that list is the actual finding, not the
duplication itself.

*Real case:* Front Page Audit wrote `TagsOnImageVote` directly. `retool/image → tagVote` applies the
moderator vote weight via `addTagVotes` and busts caches. The port had a second copy of the number that
decides whether a tag is disabled, and no cache busting.

### 2. A constant copied out of the main app

A weight, a threshold, an enum, an account id, a rate limit. If the endpoint applies it server-side,
the copy is a second source of truth that will drift silently. Grep the main app for the literal.

### 3. An endpoint parameter the slice never sends

Diff the endpoint's zod schema against the call. Optional parameters are the ones that rot: the call
keeps working, and the data it should have carried is simply absent.

*Real case:* `/api/mod/remove-images` accepts a `violationType` **enum** plus `violationDetails` and
forwards both onto the ClickHouse `DeleteTOS` event. The port sent free-text `reason` only, so every
removal was logged with no classification at all — silent, and unrecoverable after the fact.

### 4. A capability filed as "unported" that is already an endpoint action

Check the slice's audit doc and the parity checklist for anything marked absent, missing or blocked,
then look for it in the endpoint list before believing it.

*Real case:* "the whole account-edit capability — a write surface we never built" was
`retool/user → updateIdentity`, one call away. Same for `toggleModerator`.

### 5. An endpoint that accepts MORE than the Retool query used

Retool's usage is not the contract. `remove-images` takes `userId` **or** `imageIds`; one Retool query
used each, and reading only the one you were handed hides the other half.

### 6. A `privileged:` marker treated as a local role problem

Those markers **are** the per-capability permissions the tickets ask for. If the slice invents a local
role check for something the endpoint already gates, say so — and if the slice calls a privileged
action with no permission story at all, that is a finding too.

### 7. An endpoint whose comments answer an open question

The endpoint files carry decisions. One states that a Retool query's `research_ratings` insert "is
intentionally dropped (Knights of New Order replaced that data source)" — closing an item that had been
sitting on a handover as a schema to chase. If the slice has open questions, grep the endpoints for
them.

## What is NOT a finding

- **A deliberate local reimplementation with a stated reason.** `action-report` is reimplemented as
  local `setReportStatus`, which additionally rewards reporters. Better, and documented.
- **Reads.** Investigation queries belong on `dbRead`/ClickHouse; endpoints are for writes and for
  side-effectful reads.
- **An endpoint that does not exist.** Say what would have to be built and where, rather than implying
  one is available.

## Report

Per finding: the local code (`file:line`), the endpoint that should own it, **what the local path is
missing**, and how the call would change. Rank by what is lost — a missing side effect that silently
corrupts data outranks a duplicated constant.

State plainly when a slice is clean. "Checked N writes against the endpoint surface, all correctly
routed" is a useful result, and this audit will often produce it.

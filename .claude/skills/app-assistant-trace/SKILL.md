---
name: app-assistant-trace
description: "Trace a submitted App Block back to the App Assistant chats that built it and diagnose why it came out the way it did (e.g. why it shipped with the default theme): the submission's signals, the chats' frozen transcripts, and the signals in aggregate. Moderator API key required. Use for: 'why did this app ship with the default theme?', 'which sessions built <slug>?', 'read the build transcript of <publishRequestId>', 'how many submissions keep the default theme per week?'."
---

# App Assistant trace

Reads the moderator trace API (`/api/mod/apps/assistant-trace/*`). While the `app-assistant-tracing`
flag is on, civitai links each App Assistant chat to the app it works on. When an app is submitted,
civitai freezes the submitter's chats for that version as transcripts and computes **signals** for
the submission. This skill reads those. It writes nothing.

🔴 **Transcripts are users' private chats.** Never paste a transcript, or any part of one, into a PR,
issue, commit, public channel or anything outside the moderator tooling. Summarise what you found
(for example: "the assistant never read the theme docs; the user never asked for a look") and cite
the publish request id. Every transcript read is audited under your moderator account.

## Setup

```bash
cp .claude/skills/app-assistant-trace/.env.example .claude/skills/app-assistant-trace/.env
# put a moderator's FULL-ACCESS personal API key in CIVITAI_API_KEY
```

| Variable          | Required | Default               | Description                                                           |
| ----------------- | -------- | --------------------- | --------------------------------------------------------------------- |
| `CIVITAI_API_KEY` | Yes      | -                     | A moderator's full-access personal API key (any other key is refused) |
| `CIVITAI_API_URL` | No       | `https://civitai.com` | API base URL                                                          |

The process environment wins over `.env`. The key is never printed.

## Commands

```bash
T=.claude/skills/app-assistant-trace/trace.mjs
node $T request <publishRequestId>          # one submission: request, trace (signals, snapshots), live links
node $T app <slug> [--limit 20] [--cursor <publishRequestId>]   # every submission of the app + every linked chat
node $T transcript <publishRequestId> <conversationId> [--tool-output-chars 2000]   # one frozen chat
node $T signals [--from 2026-09-01] [--to 2026-12-01]           # per week + per docs topic, max 366 days
```

Output is the API's JSON on stdout. On failure the exit status is non-zero: `1` means the API or the
network refused, and stderr carries `{ status, code, error }` from the API. `2` means a usage error
or a missing key. A 401 or 403 means the key is not a full-access moderator key. A 404 on
`transcript` names why: no trace, chat not in the trace, or chat not frozen.

## Diagnosis workflow (e.g. "why did this app ship with the default theme?")

1. **Resolve the app to its submissions.** `app <slug>` lists the requests newest first, each with its
   `trace` (or `null` when tracing was off at submit or nothing could be written) and every `links`
   row for the app. Pick the request in question.
2. **Read the signals.** Use `request <publishRequestId>`, then `trace.signals`:
   - `themeCustomized` and `theme`: `tokenOverrides` (the `--civitai-*` tokens the app sets),
     `customColorCount` and `customColorFiles` (its own colours), `usesThemePackage` and
     `stylingDependencies`.
   - `readDocsTopics`: which developer-docs pages the build read, in order. Look for a theme or design
     page.
   - `editedFiles`: did the build ever touch `src/index.css`, `index.html` or a style file?
   - `toolCallCounts`: did `read_docs` run at all? Were there many failed or repeated sandbox calls?
   - `sessionCount`, `turnCount`, `buzzTotal`, `models`.
   - `trace.snapshots[].error` and `trace.snapshotError`: a chat that is `not-found` or `consent` was
     never frozen. With no frozen chat there is no transcript evidence; say so.
3. **Read the transcripts.** Use `transcript <publishRequestId> <conversationId>` for each snapshot
   with a `key`. Skim the user's messages first, then the assistant's tool calls. Raise
   `--tool-output-chars` only for the calls you need.
4. **Classify where the cause sits**, one primary cause per submission, with the evidence:
   - **User never asked**: no message asks for a look, colours, brand or style. The default is the
     expected outcome.
   - **Assistant never read the theme docs**: the user asked for a look, but `readDocsTopics` has no
     theme or design page and the styling was never attempted.
   - **Read the docs but didn't apply them**: the theme page was read, but `editedFiles` shows no
     style file and no token was set. Or the assistant said it styled the app and the bundle shows
     nothing (`themeCustomized: false`).
   - **Template or docs gap**: the assistant tried and the docs or template offered no way to do it.
     For example, it asked or searched for theming guidance that doesn't exist, or the template's
     structure fought the change.
   - **Tool failure**: the styling edits or checks failed (errors in the tool outputs, preview check
     failures, a sandbox that went away) and the build was submitted anyway.
5. **Aggregate.** `signals` gives the weekly share of `themeDefault` versus `themeCustomized`, and
   each docs topic with how many of the builds that read it customised the theme. That tells you
   whether a fix belongs in the prompt, the docs or the template.

## Blind spots of `themeCustomized`. Don't over-trust it.

It is a static scan of the submitted source against the `page-elements` template's defaults
(`src/shared/app-assistant/trace-signals.ts` in the civitai repo). It cannot see:

- colour set from code at runtime (`ctx.fillStyle = …`, a computed `setProperty`), or a colour held
  in a plain `const` and used elsewhere;
- colour carried by images, SVG files or icon fonts;
- that a token "overridden" to its own default value changes nothing: that still reads as customised;
- restyling done only through fonts, spacing or layout: that reads as default;
- minified or vendored code in the source tree, which is scanned as if the author wrote it.

`null` means the bundle had no source to scan. A submission not built in App Assistant (for example
from the CLI) has a trace with signals but no chats. Confirm a surprising verdict against the
transcript or the bundle before acting on it.

## Tests

`scripts/__tests__/app-assistant-trace-skill.test.ts` (CI's vitest `unit` project, like the dev-server
skill's tests) covers argument parsing, URL construction and exit codes against a stubbed fetch.

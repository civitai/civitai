---
name: cleanup
description: "Runs the two no-gate review lanes over everything this session touched and consolidates them: comment-review (comment necessity + false claims) and docs-drift-review (docs the session made wrong). Session-scoped, not segment-scoped. Use partway through a long session, and before opening a PR."
---

# Cleanup — the two lanes nothing else checks

Runs **`comment-review`** and **`docs-drift-review`** over the whole session's work and returns one
consolidated list.

| Agent | Reviews |
| --- | --- |
| `comment-review` | Comments: still true? earns its place? or should the code have said it? |
| `docs-drift-review` | Docs the session made wrong — stale paths, done checklist items, contradictions |

Both lanes are read-only and neither has an automated gate — comments aren't type-checked and docs are
never executed, so typecheck, lint, prettier and every test suite pass over both. That is the whole
reason this exists.

**These two lanes are pre-authorised.** Running them needs no separate permission, and neither does
re-running one that goes idle. That covers these two only; everything else about spawning is unchanged.

## 1. Scope to the SESSION, not to a segment

This is what makes it different from `civitai-review` and `svelte-review`, which scope to a slice of
work. Here the scope is everything that has happened since the session started:

```bash
git log --oneline origin/main..HEAD     # commits made this session
git diff --stat origin/main..HEAD       # their combined effect
git status --short                      # plus whatever is still uncommitted
```

🔴 **A shared worktree may contain someone else's work.** More than one agent can be editing the same
tree, and files you never touched will show up in `git status`. Before spawning, separate what this
session did from what it did not, and pass only the former. Reviewing another agent's half-finished
edits produces findings nobody asked for and can send them backwards.

If unsure whether a file is yours, say so and leave it out — a named exclusion is fine, a wrong
inclusion is not.

## 2. Fan out

Give each agent the file list and the commit range. They need different things beyond that:

- **`comment-review`** — the diff. It reviews comments *in the change*; adjacent noise is at most a
  one-line note, so it needs to know which lines are new.
- **`docs-drift-review`** — the commits, and specifically **what moved**: files added/deleted/renamed,
  symbols removed, scripts and env vars added or retired, commands whose flags changed, checklist items
  the session completed. That list is its highest-value input and it cannot recover all of it from a
  diffstat.

Serial is the safe default. Two at once is fine when the session is small.

## 3. Consolidate

One ranked list, not two reports.

- **Drop what you can disprove.** Read the code or the file before relaying anything; a fix applied to a
  non-finding is a new defect.
- Rank by blast radius: a **false comment** and a **wrong `CLAUDE.md` line** both outrank everything
  else, because both are read as authoritative and the second is an instruction that gets followed.
- Separate **fix now** from **note and move on**, and put the second group somewhere durable.
- `docs-drift-review` returns exact replacement text. Relay it verbatim rather than paraphrasing —
  paraphrasing it is how the next drift starts.

## 4. Apply

Present the list and ask before applying, unless the invoking request already said to fix.

When applying doc fixes, keep them in the **same commit as the change that caused the drift** where that
commit is still unpushed — several trackers here state that rule for themselves, and a doc fix landing
separately is how a checklist ends up describing a state that never existed.

Do not commit unless asked.

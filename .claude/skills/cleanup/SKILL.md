---
name: cleanup
description: "Runs the three review lanes that no build or test covers over everything this session touched, consolidates them, and APPLIES the fixes: comment-review (comment necessity + false claims), docs-drift-review (docs the session made wrong) and claim-review (behaviour the session's prose asserts, traced to the code). Session-scoped, not segment-scoped. Use partway through a long session, before opening a PR, and whenever a pushback has turned up an overstatement."
---

# Cleanup — the three lanes no build or test covers

Runs **`comment-review`**, **`docs-drift-review`** and **`claim-review`** over the whole session's work,
consolidates them into one list, and **applies the fixes** — the lanes produce exact replacement text, so
a run that stops at a list has done the expensive half and skipped the useful one.

| Agent | Reviews |
| --- | --- |
| `comment-review` | Comments: still true? earns its place? said in the fewest words? |
| `docs-drift-review` | Docs the session made wrong — stale paths, done checklist items, contradictions — plus padding |
| `claim-review` | Claims about behaviour — consequences, absences, "already does" — traced to the line that decides them, in docs, comments, commit messages and PR bodies |

All three lanes are read-only, and no build or test checks what they check — comments aren't
type-checked, docs are never executed, and a PR body is never read by a tool, so typecheck, lint,
prettier and every test suite pass over all of them. That is the whole reason this exists.
`comment-review` alone also runs as the hosted PR review's `comments` lane, and `civitai-review` runs
it locally when recording; that covers a PR's diff, not the session's whole work.

The first two check text against **names**; only `claim-review` follows a described behaviour to where it
is decided. A sentence whose every symbol resolves can still claim a consequence the caller never
produces — that passes the first two lanes, and is the third's whole job.

**These three lanes are pre-authorised.** Running them needs no separate permission, and neither does
re-running one that goes idle. That covers these three only; everything else about spawning is unchanged.

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
- **`claim-review`** — the commit range, the numbers of any PRs the session opened (their bodies are
  text it must read), and the docs the session touched. **Do not pass your reasoning or your own
  verdicts on the claims** — a lane handed the conclusion tends to return it confirmed. If a pushback
  already turned up an overstatement, name the claim that failed so it looks for its siblings.

Serial is the safe default. Two at once is fine when the session is small.

## 3. Consolidate

One ranked list, not three reports.

- **Drop what you can disprove.** Read the code or the file before relaying anything; a fix applied to a
  non-finding is a new defect.
- Rank by blast radius: a **false comment** and a **wrong `CLAUDE.md` line** both outrank everything
  else, because both are read as authoritative and the second is an instruction that gets followed.
- Separate **fix now** from **note and move on**, and put the second group somewhere durable.
- `docs-drift-review` returns exact replacement text. Relay it verbatim rather than paraphrasing —
  paraphrasing it is how the next drift starts.
- A `claim-review` finding that **decided something** — what a PR changed or left alone, what was
  tested — ranks with a false comment. A merged PR body cannot be edited into history; the fix is a
  correcting comment on the PR.

## 4. Apply — the run is not finished until the fixes are in the tree

**Apply them.** All three lanes return exact replacement text, and a consolidated list handed back unapplied
is a to-do the next session inherits without the context that produced it. Fix everything you did not
disprove in step 3, then say what you applied and what you deliberately left.

Ask first only when a finding needs a decision you cannot make — a comment whose fix is a rename, a doc
whose correct value you cannot verify from the repo (whether a migration was applied, whether a box
should be ticked). Reopen a box rather than assert something you could not check, and say so.

**Then verify each edit landed.** Do not trust the write — re-read or grep for the new text. Three ways
these fail silently:

- **The anchor is stale.** The lanes quote the file as it was when they read it, and a long review runs
  minutes behind the tree. An anchor that no longer matches is normal, not a sign the finding is wrong —
  re-read that region and re-derive the edit.
- **A batch that throws part-way applies NOTHING** if it writes the file after the last replacement.
  Prefer one file per write, or verify per file. This is the failure that quietly drops half a lane.
- **Another session may be editing the same tree.** A file can be rewritten under you between the edit
  and the check; see the shared-worktree warning in step 1.

When applying doc fixes, keep them in the **same commit as the change that caused the drift** where that
commit is still unpushed — several trackers here state that rule for themselves, and a doc fix landing
separately is how a checklist ends up describing a state that never existed.

Optional findings about **pre-existing** drift are still worth applying when they touch what the session
changed: a contradiction two hundred lines from your edit still points the next reader at the wrong
state. Say which ones were not yours.

Re-run `typecheck` and the suites covering the touched files afterwards — a comment edit cannot break a
build, but these lanes also move code-adjacent text (test names, doc blocks in `.ts`), and the point of
the pass is that nothing else checks them.

Do not commit unless asked.

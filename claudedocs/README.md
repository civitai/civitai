# claudedocs/

In-depth technical documents: RCAs, audits, analyses, handovers, and investigations.

These are **not** auto-loaded by agents — they cost nothing until someone opens them.
They live here (not in `docs/`) because they contain operational detail, investigation
methodology, and measured evidence that would be noise in user-facing feature docs.

## Status-line convention

Every document that asserts an outcome (a fix landed, a proposal was merged, a
measurement holds, a recommendation stands) must carry a **status line** that names
the commit SHA or PR number the claim was true at. This makes the status a claim
about a point in history, not about the present, so it can be re-verified rather
than re-trusted.

### Format

The status line goes immediately after the document's `#` heading, as a bold
`**Status:**` paragraph. The first word after the colon is the status category,
followed by the evidence:

```markdown
# Document Title

**Status:** merged. PR #NNNN (merged YYYY-MM-DD). <one-sentence summary>.
```

### Categories

- **merged** — the change landed. Name the PR and merge date.
- **open** — the issue/PR is still open. Name the PR.
- **diagnosed, not fixed** — root cause known, no fix shipped. Say what would fix it.
- **historical snapshot** — the doc captures a point-in-time measurement or analysis.
  Say what it was measured at (commit SHA, branch, date).
- **recommendation unchanged** — the doc's recommendation still holds. Say when it
  was last checked.

### Corrections

When a status has changed since the doc was written, state the correction **in place**
rather than silently editing out the old claim. Use the pattern from
`runner-scouting-2026-08-15.md`:

```markdown
**Status (corrected YYYY-MM-DD):** <new status>. <evidence>.
```

The original text is not removed — the correction block sits above or replaces the
old status line, and the body of the document is left untouched.

### What NOT to put in a status line

- Internal infrastructure names, hostnames, or deployment details (this repo is public).
- Operational specifics that belong in the private infra repo.
- Claims that require running the codebase to verify (e.g., "coverage is still 32%").

### Verification

Re-derive a doc's status against the repository (`gh pr view`, `git log`), never
from the doc's own text. An audit that reads each doc's self-reported status instead
of re-checking the repo will get the same wrong answers the doc already has.

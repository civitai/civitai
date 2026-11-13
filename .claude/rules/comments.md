---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.svelte"
  - "**/*.scss"
---

# Comments

Comments are not type-checked, so they rot silently. Write the minimum comment needed and bias toward none.

## What to write

- **Default to no comment.** Prefer a clearer name, smaller method, or better type over a comment explaining confusing code.
- **Comment only the non-obvious why:** a rationale, tradeoff, gotcha, invariant or workaround the code can't convey. Link an issue/PR when relevant.
- **Keep it to a line or two.** A long block means the code or naming should be clearer.

## What not to write

- **Never narrate the what.** No restating the next line, no labelling obvious steps (`// loop over items`), nothing a well-named symbol already says.
- **Don't describe nearby code's current behavior** (e.g. "this gates on X so Y happens"); that goes stale when the other code changes. Comment the surprising fact, not the mechanics.
- **No process noise:** no change-log narration (`// added to fix...`), no "I changed X", no section banners, no commented-out code.
- **Explain decisions in your reply, not in the file.** Rationale for a choice you just made, or what you rejected, belongs in chat. A comment justifying your work to a reviewer is the most common violation.

## How to write them

- **Comment in a separate pass.** Write the code with no comments, reread it, and add back only what's needed. Comments written while authoring feel non-obvious when they aren't.
- **The keep test.** For each surviving comment, name the specific future edit that goes wrong without it. "It's helpful context" or "it explains why this is correct" means delete it.
- **Clean up as you go.** When you edit near stale, redundant or what-narrating comments, delete or fix them. Keep it scoped to what you're already touching, not a separate sweep.

## Enforcement

Nothing in the toolchain checks comments; typecheck, lint, prettier and tests all pass over a false one. The `comment-review` agent is the only gate: it applies the keep test, flags comments whose claims no longer resolve, trims survivors, and calls out those whose real fix is a better name.

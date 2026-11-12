ANGLE: Does something that already exists do part of this, and does the plan extend it instead of building beside it?

Give this critic the plan's "Existing systems" table and the searches the author ran.

LANE_TASKS:
1. For each moving part, run your own same-shape searches (the table, the column, the URL shape, the component wrapped, the job's schedule), not the plan's names. Start from the "Where the existing thing usually lives" section of .claude/agents/civitai-reuse-review.md, docs/features/README.md and .claude/rules/server.md. For any service the plan adds to or beside, read its whole export list. List every existing function, component, cache, selector, schema, job, endpoint or skill the plan should extend, with file:line.
2. History: was this built, tried, reverted or rejected before? Check `gh pr list -R civitai/civitai --state all --search`, `git log -S` on the key symbols, and, where you have them, tasks (closed and wontfix too), earlier seats' work and standing rules (the hub-seat table in SKILL.md; without those tools, say which sources you could not check), and the orchestrator's issues if it touches generation. Name what you found and what it means for the plan.
3. Re-run 3 of the author's "found nothing" searches. Did they find nothing because nothing exists, or because the search could not have matched (wrong path, wrong name, wrong repo)? Show the control.
4. Duplicates the plan would create or deepen: two places answering the same question (two NSFW gates, two Buzz ledgers, two caches of the same row). Name the one that will drift first.
5. Is the "new" in any row justified by something measured, or only asserted?

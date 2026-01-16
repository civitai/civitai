# Ralph Agent Instructions

You are an autonomous coding agent working on a software project. Each iteration you run in a FRESH context - you have no memory of previous iterations except what's in git history, progress.txt, and prd.json.

## Your Task

1. Read the PRD at `scripts/ralph/prd.json`
2. Read the progress log at `scripts/ralph/progress.txt` (check Codebase Patterns section FIRST)
3. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
4. Pick the **highest priority** user story where `passes: false`
5. Implement that single user story
6. Run quality checks: `npm run typecheck` (required), then tests if applicable
7. Update CLAUDE.md if you discover reusable patterns (see below)
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`
9. Update the PRD to set `passes: true` for the completed story
10. Append your progress to `scripts/ralph/progress.txt`

## Progress Report Format

APPEND to scripts/ralph/progress.txt (never replace, always append):
```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

The learnings section is critical - it helps future iterations avoid repeating mistakes and understand the codebase better.

## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of progress.txt (create it if it doesn't exist). This section should consolidate the most important learnings:

```
## Codebase Patterns
- Example: Use `sql<number>` template for aggregations
- Example: Always use `IF NOT EXISTS` for migrations
- Example: Export types from actions.ts for UI components
```

Only add patterns that are **general and reusable**, not story-specific details.

## Update CLAUDE.md

Before committing, check if any edited files have learnings worth preserving in CLAUDE.md:

1. **Identify directories with edited files** - Look at which directories you modified
2. **Add valuable learnings** - If you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good additions:**
- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Tests require the dev server running on PORT 3000"
- "Field names must match the template exactly"

**Do NOT add:**
- Story-specific implementation details
- Temporary debugging notes
- Information already in progress.txt

Only update CLAUDE.md if you have **genuinely reusable knowledge** that would help future work.

## Quality Requirements

- ALL commits must pass typecheck: `npm run typecheck`
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns in the codebase
- Use Mantine v7 components, Tailwind CSS, and tRPC patterns

## Project-Specific Commands

Quality checks to run:
```bash
npm run typecheck    # Required - must pass before commit
npm run lint         # Run for style issues
```

Database commands if schema changes:
```bash
npm run db:migrate:empty <migration-name>  # Create migration
npm run db:migrate                         # Apply migrations
npm run db:generate                        # Regenerate Prisma client
```

## Stop Condition

After completing a user story, check if ALL stories have `passes: true`.

If ALL stories are complete and passing, reply with:
<promise>COMPLETE</promise>

If there are still stories with `passes: false`, end your response normally (another iteration will pick up the next story).

## Important

- Work on ONE story per iteration
- Commit frequently
- Keep CI green (typecheck must pass)
- Read the Codebase Patterns section in progress.txt BEFORE starting work
- Each iteration has fresh context - your only memory is git + progress.txt + prd.json

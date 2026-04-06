# Standard PRD - Code Implementation

This PRD involves implementing code. Follow these additional guidelines.

## Git Branch (before base step 1)

Before reading the PRD, ensure you're on the correct branch:
1. Check you're on the branch from PRD `branchName`
2. If not, check it out or create from main

## Quality Requirements

- ALL commits must pass typecheck: `npm run typecheck`
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns in the codebase
- Use Mantine v7 components, Tailwind CSS, and tRPC patterns

## After Completing Work (between base steps 6 and 7)

After executing the acceptance criteria but before marking the story as passing:
1. Run quality checks: `npm run typecheck` (required)
2. Run linting if applicable: `npm run lint`
3. Commit ALL changes with message: `feat: [Story ID] - [Story Title]`

## Git Commit Rules

- **NEVER use `git add -f` or `--force`** - If a file is gitignored, it should NOT be committed
- The PRD and progress log are gitignored intentionally - do not force-add them
- Only commit source code changes, not Ralph project tracking files
- If `git add` silently skips files, that's correct behavior - they're gitignored for a reason

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
- Information already in progress log

Only update CLAUDE.md if you have **genuinely reusable knowledge** that would help future work.

## Project Commands

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

## Important for Code PRDs

- Commit frequently
- Keep CI green (typecheck must pass)

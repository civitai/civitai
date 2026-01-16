---
name: ralph
description: Convert a markdown plan/PRD into prd.json format for the Ralph autonomous agent loop. Use when the user wants to tackle a big project, has a plan document to execute, or mentions "ralph" or autonomous agent. This skill creates the PRD, runs the agent loop, reviews results, and creates follow-up PRDs as needed.
---

# Ralph - Autonomous Agent Loop

Ralph is an autonomous coding agent that tackles big projects by:
1. Breaking work into discrete user stories
2. Running fresh Claude instances for each story (avoiding context rot)
3. Tracking progress across iterations
4. Self-correcting through progress logs

## Complete Workflow

When the user invokes `/ralph` with a plan document, follow this complete workflow:

```
┌─────────────────────────────────────────────────────────────┐
│  1. PLAN → PRD                                               │
│     Convert markdown plan to structured prd.json             │
├─────────────────────────────────────────────────────────────┤
│  2. RUN RALPH                                                │
│     Execute autonomous loop (10-40+ minutes)                 │
├─────────────────────────────────────────────────────────────┤
│  3. REVIEW                                                   │
│     Check work done, run agent-review against spec           │
├─────────────────────────────────────────────────────────────┤
│  4. FOLLOW-UP PRD (if needed)                                │
│     Create new PRD with fixes, remaining work                │
│     → Loop back to step 2                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Convert Plan to PRD

### Step 1.1: Read and Understand the Plan

The user provides a markdown plan document (path or content). **Read it thoroughly first.**

Look for:
- Feature goals and requirements
- User stories or tasks described
- **Mockups or design references** (HTML files, images, Figma links)
- Technical constraints or dependencies
- Non-goals or out-of-scope items

### Step 1.2: Ask Clarifying Questions (if needed)

If the plan is ambiguous, ask 3-5 clarifying questions with lettered options:

```
1. What is the primary goal?
   A. Improve user experience
   B. Add new functionality
   C. Fix existing issues
   D. Other: [please specify]

2. What is the scope?
   A. Minimal viable version
   B. Full-featured implementation
   C. Backend only
   D. Frontend only
```

Users can respond quickly with "1A, 2B" format.

### Step 1.3: Create the PRD

Create a project folder based on the feature/branch name:
```
.claude/skills/ralph/projects/<project-name>/prd.json
```

For example, if building a user profile page:
```
.claude/skills/ralph/projects/user-profile-page/prd.json
```

Use this structure:

```json
{
  "description": "Brief description of the feature/project",
  "branchName": "feature/descriptive-branch-name",
  "mockups": [
    {
      "path": "docs/working/mockups/feature/v1-layout.html",
      "description": "Main layout showing card grid approach"
    }
  ],
  "designReferences": [
    {
      "path": "docs/designs/feature-screenshot.png",
      "description": "Reference design from Figma export"
    }
  ],
  "userStories": [
    {
      "id": "US001",
      "title": "Short descriptive title",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        "Specific testable criterion 1",
        "Specific testable criterion 2",
        "Typecheck passes"
      ],
      "mockupRef": "v1-layout.html",
      "priority": 1,
      "passes": false
    }
  ]
}
```

### PRD Fields Reference

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Brief summary of the project |
| `branchName` | Yes | Git branch to work on |
| `mockups` | No | Array of HTML mockup files with paths and descriptions |
| `designReferences` | No | Array of images/screenshots referenced in the plan |
| `userStories` | Yes | Array of stories to implement |

### User Story Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique ID (US001, US002, etc.) |
| `title` | Yes | Short descriptive title |
| `description` | Yes | "As a [user], I want [feature] so that [benefit]" format |
| `acceptanceCriteria` | Yes | Array of specific, testable criteria |
| `mockupRef` | No | Reference to a mockup file for this story |
| `priority` | Yes | 1-N where 1 is highest priority |
| `passes` | Yes | Always start as `false` |

### Conversion Guidelines

**Priority Assignment:**
- **Priority 1**: Foundation/setup - database migrations, types, base components
- **Priority 2-3**: Core functionality - main features that depend on foundation
- **Priority 4-5**: Secondary features - enhancements, additional functionality
- **Priority 6+**: Polish - edge cases, nice-to-haves, refinements

**Story Sizing:**
- Each story = 1-3 files of changes (not 10-file refactors)
- If a feature is big, split into multiple stories
- Stories should be independently completable where possible

**Acceptance Criteria:**
- Write testable, specific criteria (not vague like "works correctly")
- Include "Typecheck passes" for code changes
- **For UI stories:** Include "Matches mockup [filename]" if mockup exists
- Mention any integration points or dependencies

**Mockup Handling:**
- If plan references mockups (`.html` files), include them in `mockups` array
- If plan references images/screenshots, include them in `designReferences`
- Link stories to their relevant mockups via `mockupRef`
- Ralph will read these files to understand the expected UI

**Branch Naming:**
- Use descriptive branch names: `feature/crucible-discovery`, `fix/auth-timeout`
- Match the project's existing branch conventions

### Example Conversion

**Input markdown:**
```markdown
# Add user profile page

See mockup: docs/working/mockups/profile/v1-sidebar.html
Reference design: docs/designs/profile-figma.png

## Features
- Show user's avatar and bio
- Display their recent posts
- Allow editing profile info

## Non-goals
- No follower system yet
- No activity feed
```

**Output prd.json:**
```json
{
  "description": "Add user profile page with avatar, bio, posts, and editing",
  "branchName": "feature/user-profile-page",
  "mockups": [
    {
      "path": "docs/working/mockups/profile/v1-sidebar.html",
      "description": "Profile layout with sidebar for user info"
    }
  ],
  "designReferences": [
    {
      "path": "docs/designs/profile-figma.png",
      "description": "Reference design from Figma"
    }
  ],
  "userStories": [
    {
      "id": "US001",
      "title": "Create profile page route and layout",
      "description": "As a user, I want to view profiles at /user/[username] so I can see other users' information",
      "acceptanceCriteria": [
        "Route /user/[username] exists and loads",
        "Page has sidebar + main content layout matching mockup",
        "Typecheck passes"
      ],
      "mockupRef": "v1-sidebar.html",
      "priority": 1,
      "passes": false
    },
    {
      "id": "US002",
      "title": "Display user avatar and bio",
      "description": "As a user, I want to see a user's avatar and bio so I can learn about them",
      "acceptanceCriteria": [
        "Avatar displays with fallback for missing image",
        "Bio text shows with proper formatting",
        "Loading state while fetching user data",
        "Typecheck passes"
      ],
      "priority": 2,
      "passes": false
    },
    {
      "id": "US003",
      "title": "Show recent posts list",
      "description": "As a user, I want to see a user's recent posts so I can explore their content",
      "acceptanceCriteria": [
        "Posts load with pagination (10 per page)",
        "Each post shows title, date, preview",
        "Empty state when no posts",
        "Typecheck passes"
      ],
      "priority": 2,
      "passes": false
    },
    {
      "id": "US004",
      "title": "Add profile editing",
      "description": "As a user, I want to edit my profile so I can update my information",
      "acceptanceCriteria": [
        "Edit button visible only to profile owner",
        "Modal/form for editing bio",
        "Changes persist after save",
        "Validation for bio length",
        "Typecheck passes"
      ],
      "priority": 3,
      "passes": false
    }
  ]
}
```

---

## Phase 2: Run Ralph

After creating the PRD, run the Ralph autonomous loop.

### Command

```bash
node .claude/skills/ralph/ralph.mjs [options]
```

### Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--prd <path>` | `-p` | `.claude/skills/ralph/prd.json` | Path to PRD |
| `--max-iterations <n>` | `-n` | story count | Max iterations |
| `--model <model>` | `-m` | opus | Model: opus, sonnet, haiku |
| `--cwd <path>` | `-C` | script location | Working directory for Ralph |
| `--quiet` | `-q` | | Suppress banners |
| `--dry-run` | | | Preview without executing |
| `--no-commit` | | | Skip git commits (for testing) |

### Recommended Usage

```bash
# Run with project-specific PRD
node .claude/skills/ralph/ralph.mjs --prd .claude/skills/ralph/projects/user-profile/prd.json

# Dry run first to verify PRD
node .claude/skills/ralph/ralph.mjs --prd .claude/skills/ralph/projects/user-profile/prd.json --dry-run
```

### Execution Time

Ralph runs autonomously. Depending on story complexity:
- Simple stories: ~2-5 minutes each
- Complex stories: ~10-15 minutes each
- A 10-story PRD: ~20-60 minutes total

The user can walk away and return when complete.

### Monitoring (Optional)

```bash
# Check remaining stories (replace <project> with your project name)
cat .claude/skills/ralph/projects/<project>/prd.json | node -e "
  const p=JSON.parse(require('fs').readFileSync(0,'utf8'));
  const done = p.userStories.filter(s=>s.passes).length;
  const total = p.userStories.length;
  console.log('Progress:', done + '/' + total);
"

# Read progress log
cat .claude/skills/ralph/projects/<project>/progress.txt
```

---

## Phase 3: Review Results

After Ralph completes (or reaches max iterations), review the work.

### 3.1 Check What Was Done

```bash
# See all commits made
git log --oneline -20

# See files changed
git diff main..HEAD --stat

# Check remaining stories (replace <project> with your project name)
cat .claude/skills/ralph/projects/<project>/prd.json | node -e "
  const p=JSON.parse(require('fs').readFileSync(0,'utf8'));
  p.userStories.filter(s=>!s.passes).forEach(s =>
    console.log('INCOMPLETE:', s.id, '-', s.title)
  );
"
```

### 3.2 Run Agent Review

Use the agent-review skill to get an external perspective on the changes:

```bash
# Get the original spec (replace <project> with your project name)
SPEC=$(cat .claude/skills/ralph/projects/<project>/prd.json)

# Review changes against spec
git diff main..HEAD | node .claude/skills/agent-review/query.mjs -m gemini "
Review these code changes against this specification:

$SPEC

Check for:
1. Does the implementation fully satisfy each acceptance criterion?
2. Are there any bugs, edge cases, or issues?
3. What's missing or incomplete?
4. Any code quality concerns?

Provide a structured report with:
- Stories that are COMPLETE and correct
- Stories that are INCOMPLETE or have issues
- Specific fixes needed
"
```

### 3.3 Review Progress Log

Read the progress log for issues Ralph noted:

```bash
cat .claude/skills/ralph/projects/<project>/progress.txt
```

Look for:
- TODOs or deferred work
- Patterns that caused issues
- Workarounds or shortcuts taken

### 3.4 Run Quality Checks

```bash
npm run typecheck
npm run lint
npm test  # if applicable
```

---

## Phase 4: Follow-up PRD (if needed)

If review identifies remaining work, create a follow-up PRD.

### When to Create Follow-up

Create a new PRD if:
- Stories remain with `passes: false`
- Agent review identified bugs or missing features
- Quality checks revealed issues
- Progress log noted TODOs

### Follow-up PRD Structure

1. **Copy incomplete stories** from original PRD (reset `passes: false`)
2. **Add bug fix stories** for issues found in review
3. **Add polish stories** for any rough edges
4. **Re-prioritize** based on dependencies

### Example Follow-up PRD

```json
{
  "description": "User profile page - follow-up fixes",
  "branchName": "feature/user-profile-page",
  "userStories": [
    {
      "id": "US003-FIX",
      "title": "Fix pagination in posts list",
      "description": "Posts pagination was not working correctly - fix the offset calculation",
      "acceptanceCriteria": [
        "Page 2 shows different posts than page 1",
        "No duplicate posts across pages",
        "Total count is accurate"
      ],
      "priority": 1,
      "passes": false
    },
    {
      "id": "US004-RETRY",
      "title": "Complete profile editing feature",
      "description": "Profile editing was partially implemented - complete the save functionality",
      "acceptanceCriteria": [
        "Save button calls API endpoint",
        "Success toast appears after save",
        "Profile updates without page refresh"
      ],
      "priority": 1,
      "passes": false
    }
  ]
}
```

### Run Ralph Again

```bash
# Run with the follow-up PRD
node .claude/skills/ralph/ralph.mjs --prd .claude/skills/ralph/projects/<project>/prd.json

# Then review again (Phase 3)
```

---

## The Complete Loop

```
/ralph <plan.md>
    │
    ├── Read plan, create project folder
    │   └── .claude/skills/ralph/projects/<project>/prd.json
    │
    ├── Run: node .claude/skills/ralph/ralph.mjs --prd .../prd.json
    │   └── (wait 20-60 minutes)
    │
    ├── Review results
    │   ├── git log, git diff
    │   ├── agent-review against spec
    │   └── npm run typecheck
    │
    ├── If all good → DONE
    │
    └── If issues remain:
        ├── Update prd.json with fixes
        └── Loop back to Run
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `.claude/skills/ralph/ralph.mjs` | Main loop script |
| `.claude/skills/ralph/prompt.md` | Instructions for each iteration |
| `.claude/skills/ralph/projects/<name>/prd.json` | Project PRD (you create this) |
| `.claude/skills/ralph/projects/<name>/progress.txt` | Auto-generated progress log |

The `projects/` folder is gitignored - PRDs are temporary working files.

---

## Tips for Success

1. **Quality PRD = Quality Results** - Spend time on clear acceptance criteria
2. **Start Small** - First time? Try a 3-5 story PRD
3. **Use Dry Run** - Preview with `--dry-run` before committing to execution
4. **Monitor Early** - Check progress after 10 minutes to catch issues
5. **Review Thoroughly** - Agent review catches things Ralph might miss
6. **Iterate** - Expect 2-3 Ralph runs for complex features
7. **Increase iterations if needed** - Use `-n 20` if stories need retries

## Project Isolation

Each project gets its own folder in `.claude/skills/ralph/projects/`, so multiple projects can coexist without conflicts. PRDs and progress files are preserved for history.

### Running Ralph in a Worktree

To run Ralph in a different worktree from your current directory:

```bash
# 1. Create the worktree (if needed)
git worktree add ../model-share-feature feature/my-feature

# 2. Create PRD in the worktree's project folder
mkdir -p ../model-share-feature/.claude/skills/ralph/projects/my-feature

# 3. Run Ralph with --cwd pointing to the worktree
node .claude/skills/ralph/ralph.mjs \
  --cwd ../model-share-feature \
  --prd ../model-share-feature/.claude/skills/ralph/projects/my-feature/prd.json
```

Ralph will work entirely within the worktree - it has no knowledge of where it was spawned from.

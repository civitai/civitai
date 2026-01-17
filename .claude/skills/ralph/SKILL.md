---
name: ralph
description: Prepare PRDs for autonomous agent execution. Converts markdown plans into structured prd.json files with user stories, acceptance criteria, and mockup references. After PRD is ready, use /ralph-daemon to run and monitor execution.
---

# Ralph - PRD Preparation

Ralph is an autonomous coding agent that tackles big projects. This skill helps you **prepare PRDs** (Product Requirement Documents) that Ralph can execute.

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────┐
│  1. PLAN → PRD (this skill)                                  │
│     Convert markdown plan to structured prd.json             │
├─────────────────────────────────────────────────────────────┤
│  2. EXECUTE (/ralph-daemon)                                  │
│     Run autonomous loop with monitoring & control            │
├─────────────────────────────────────────────────────────────┤
│  3. REVIEW & ITERATE                                         │
│     Check results, create follow-up PRD if needed            │
└─────────────────────────────────────────────────────────────┘
```

**After creating a PRD, use `/ralph-daemon` to execute it.** The daemon provides session management, real-time monitoring, pause/resume, and recovery across restarts.

---

## Creating a PRD

### Step 1: Read and Understand the Plan

The user provides a markdown plan document (path or content). **Read it thoroughly first.**

Look for:
- Feature goals and requirements
- User stories or tasks described
- **Mockups or design references** (HTML files, images, Figma links)
- Technical constraints or dependencies
- Non-goals or out-of-scope items

### Step 2: Ask Clarifying Questions (if needed)

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

### Step 3: Create the PRD

Create a project folder based on the feature/branch name:
```
.claude/skills/ralph/projects/<project-name>/prd.json
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

---

## PRD Reference

### PRD Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Brief summary of the project |
| `branchName` | Yes | Git branch to work on |
| `type` | No | PRD type: `code` (default), `orchestrator`, `testing` |
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

### PRD Types

| Type | Use Case |
|------|----------|
| `code` (default) | Code implementation - commits code, runs typecheck |
| `orchestrator` | Coordinates multiple sub-Ralphs, manages shared state |
| `testing` | Browser automation testing, creates comparison reports |

---

## Writing Good PRDs

### Priority Assignment

- **Priority 1**: Foundation/setup - database migrations, types, base components
- **Priority 2-3**: Core functionality - main features that depend on foundation
- **Priority 4-5**: Secondary features - enhancements, additional functionality
- **Priority 6+**: Polish - edge cases, nice-to-haves, refinements

### Story Sizing

- Each story = 1-3 files of changes (not 10-file refactors)
- If a feature is big, split into multiple stories
- Stories should be independently completable where possible

### Acceptance Criteria

- Write testable, specific criteria (not vague like "works correctly")
- Include "Typecheck passes" for code changes
- **For UI stories:** Include "Matches mockup [filename]" if mockup exists
- Mention any integration points or dependencies

### Mockup Handling

- If plan references mockups (`.html` files), include them in `mockups` array
- If plan references images/screenshots, include them in `designReferences`
- Link stories to their relevant mockups via `mockupRef`
- Ralph will read these files to understand the expected UI

---

## Example Conversion

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

## Orchestrator PRD Example

For coordinating multiple sub-PRDs:

```json
{
  "description": "Master orchestrator for visual testing",
  "branchName": "feature/testing",
  "type": "orchestrator",
  "context": {
    "sharedStateFile": ".claude/skills/ralph/projects/my-testing/shared-state.json",
    "subProjects": {
      "setup": ".claude/skills/ralph/projects/test-setup/prd.json",
      "verify": ".claude/skills/ralph/projects/test-verify/prd.json"
    }
  },
  "userStories": [
    {
      "id": "US001",
      "title": "Run setup tests first",
      "description": "As an orchestrator, I want to run setup tests first since they create test data",
      "acceptanceCriteria": [
        "Spawn child session for test-setup PRD",
        "Wait for completion",
        "Verify shared state contains expected outputs"
      ],
      "priority": 1,
      "passes": false
    }
  ]
}
```

---

## After Creating the PRD

Once your PRD is ready, **use `/ralph-daemon` to execute it**. The daemon provides:

- **Session management** - Create, start, pause, resume, abort sessions
- **Real-time monitoring** - WebSocket streaming, Web UI dashboard
- **Persistence** - Sessions survive daemon restarts
- **Guidance injection** - Send hints or corrections mid-execution
- **Orchestration** - Parent-child sessions for complex workflows

---

## Review and Follow-up

After execution completes, review the results:

1. **Check git history** - `git log --oneline -20`
2. **Review changes** - `git diff main..HEAD --stat`
3. **Check PRD status** - Look at which stories have `passes: true`
4. **Run quality checks** - `npm run typecheck`, `npm run lint`

If issues remain, create a **follow-up PRD**:

1. Copy incomplete stories (reset `passes: false`)
2. Add bug fix stories for issues found
3. Re-prioritize based on dependencies
4. Execute again with `/ralph-daemon`

---

## Tips for Success

1. **Quality PRD = Quality Results** - Spend time on clear acceptance criteria
2. **Start Small** - First time? Try a 3-5 story PRD
3. **Review Thoroughly** - Agent review catches things Ralph might miss
4. **Iterate** - Expect 2-3 Ralph runs for complex features

## Project Isolation

Each project gets its own folder in `.claude/skills/ralph/projects/`, so multiple projects can coexist without conflicts. PRDs and progress files are preserved for history.

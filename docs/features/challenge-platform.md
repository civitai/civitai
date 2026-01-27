# Challenge Queue System Proposal

## Overview

This document proposes a system for pre-preparing daily challenges, allowing moderators to schedule, view, and edit upcoming challenges before they go live.

## Goals

1. Allow mods to see and manage upcoming challenges
2. Support manual theme/content override instead of AI generation
3. Enable theme previews for users (configurable visibility)
4. Maintain backward compatibility with auto-generation as fallback

---

## Architecture Decision

### Recommendation: New `ChallengeQueue` Table

@ai: I recommend Option A (new table) over extending Article metadata because:
- Clean separation of concerns (queue management vs content)
- Proper audit trail (who created/modified)
- Easy to query and reorder
- No risk of polluting existing Article data

### Schema

```prisma
model ChallengeQueue {
  id              Int       @id @default(autoincrement())
  scheduledDate   DateTime  @db.Date  // The date this challenge runs
  challengeType   String    @default("world-morph")

  // Content (optional - AI fills gaps if null)
  theme           String?   // 1-2 word theme
  modelId         Int?      // Featured model (auto-select if null)
  title           String?   // Article title override
  invitation      String?   // Custom invitation text
  customContent   String?   // Full article body override

  // Lifecycle
  status          ChallengeQueueStatus @default(Queued)
  articleId       Int?      // Links to created Article when activated

  // Audit
  createdById     Int
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // Relations
  createdBy       User      @relation(fields: [createdById], references: [id])
  model           Model?    @relation(fields: [modelId], references: [id])
  article         Article?  @relation(fields: [articleId], references: [id])
}

enum ChallengeQueueStatus {
  Queued      // Waiting to be activated
  Active      // Currently running
  Completed   // Finished
  Skipped     // Manually skipped by mod
}
```

@dev: Yeah, I think it makes sense to make a new table here. I almost wonder if we actually stop utilizing the article system altogether and instead actually make unique UI views for challenges and things like that.

@ai: Agreed - if we're building this out as a full feature, the Article system is awkward. Challenges have unique lifecycle, scoring, entries, winners - none of that maps well to Articles. A dedicated `Challenge` table with its own pages makes more sense. We'd have `/challenges` for the public feed and `/challenges/[id]` for individual challenge pages.

@dev: Okay, I like this because it kind of opens it up to other suggestions that you gave me earlier in our conversation. and kind of per-user type things like streak tracking, number of entries they've had reviewed, that sort of stuff.

@ai: Exactly. With a proper Challenge entity we can easily add a `UserChallengeStats` table or computed fields for:
- Total challenges participated
- Total wins / placements
- Current streak (consecutive challenges entered)
- Entries scored / reviewed
- Buzz earned from challenges

---

## Scheduling Rules

### How Far Ahead?

@ai: I suggest **30 days** as the default horizon. This gives mods enough time to plan around events/holidays without creating excessive maintenance burden.

@dev: Sounds good.

### Auto-Fill Behavior

When the setup job runs, it checks for queued challenges in this priority:

1. **Queued challenge exists for target date** → Use it
2. **No queued challenge** → Auto-generate via AI (current behavior)

This means the queue is optional - the system continues working if mods don't pre-schedule.

### Conflict Handling

If multiple queue entries exist for the same date:
- Use the one with lowest `id` (first created)
- Log warning for mod review

@dev: If we're going to be overhauling the system anyways, let's allow multiple challenges per day and potentially make it so that challenges can run for more than a day, and there's a whole challenges section to the site.

@ai: Makes sense. This means we shift from `scheduledDate` to `startsAt` + `endsAt` fields. Multiple challenges can overlap. The challenges feed would show all active challenges, sorted by end date (soonest ending first) or by creation date. This opens up interesting possibilities:
- Flash challenges (4-hour sprints)
- Weekend challenges (Fri-Sun)
- Week-long epic challenges
- Multiple concurrent daily challenges with different themes

---

## Mod Interface

### Location

New page at `/moderator/challenges` (or `/moderator/daily-challenges`)

@dev: /moderator/challenges

### Views

#### Calendar View
- Month calendar showing scheduled challenges
- Color coding: queued (blue), active (green), completed (gray), gaps (red)
- Click date to create/edit

#### List View
- Table of upcoming challenges
- Columns: Date, Theme, Model, Status, Created By, Actions
- Drag-to-reorder support (updates `scheduledDate`)
@dev: Let's stick with just a list view for now.

### Create/Edit Modal

```
┌─────────────────────────────────────────────────┐
│ Schedule Challenge                              │
├─────────────────────────────────────────────────┤
│ Date:        [Jan 15, 2026      ▼]             │
│                                                 │
│ Model:       [Search models...        ] [Auto] │
│              Preview: ModelName by Creator      │
│                                                 │
│ Theme:       [________________] [✨ Suggest]   │
│              AI suggestions: "Neon Dreams",     │
│              "Forgotten Worlds", "Time Loop"    │
│                                                 │
│ Title:       [________________] (optional)      │
│                                                 │
│ Invitation:  [________________] (optional)      │
│              Default: AI-generated              │
│                                                 │
│ ┌─ Advanced ──────────────────────────────┐    │
│ │ Custom Article Content (markdown)        │    │
│ │ [                                    ]   │    │
│ └──────────────────────────────────────────┘    │
│                                                 │
│        [Cancel]  [Preview]  [Save]             │
└─────────────────────────────────────────────────┘
```

### Bulk Actions

- **"Auto-fill Next 7 Days"** - Generate AI themes for empty slots
- **"Skip Challenge"** - Mark a queued challenge as skipped
- **"Regenerate"** - Re-run AI generation for a queued item

@dev: I think we would want to have a job that automatically adds to the end of the queue so that we always have 30 in the queue or whatever. Basically that the horizon's always full, rather than having an autofill next seven days button or whatever. As for skip challenge, I'd imagine that instead we'd probably want to have just a, I don't know, a regenerate button. I don't think that we need a skip. Maybe if we're going to allow multiple challenges to exist on a specific day, we would need to have a delete button for challenges.

@ai: Got it. So the job becomes "ensure at least N system-generated challenges exist in the queue for the next 30 days". If mods/users have manually created challenges for those dates, those count toward the total. Actions would be:
- **Delete** - Remove a challenge entirely (with confirmation)
- **Regenerate** - Re-roll AI fields (theme, title, model) for a queued challenge
- **Edit** - Manual adjustments

---

## Theme Preview (Public)

### Visibility Options

@ai: I suggest a tiered approach:

| Audience | What They See | When |
|----------|---------------|------|
| Mods | All queued challenges with full details | Always |
| Logged-in users | Next 3 themes (theme + model name only) | 24h before each |
| Public | Current challenge only | When active |

@dev: Maybe we make it so that challenges have a status or like a public flag or something like that. If we're going to be doing flags, we probably should do it as bitwise flags just so that we can add more later. Nah, probably don't need that. Overcomplicating things. Anyway, point is that things should change to, you know, public or whatever once they're within seven days. and then everybody can see them. But then mods can see beyond that. Or maybe we have like a visibility date on the challenge, so that, you know, if we have a really big challenge coming next month, you can see it the month before. I think that probably is even better. And then, um, if we're gonna make it a whole, if we're already making it so that, you know, it's its own thing, I wonder if we actually make it so that users can create challenges as well. How much work would that take?" And then we would just have, you know, AI automatically creates them for kind of us as a system, and then mods would be able to review and manage those. And then obviously mods could edit any challenge, but users would be able to edit their own challenges. And I guess we would need some sort of filter on the challenges feed for users to be able to go see their created challenges, whether they're done or not. and then I guess there'd have to be something to toggle to visible and completed challenges or something.

@ai: I like the `visibleAt` field approach - simple and flexible. Auto-set to 7 days before `startsAt` by default, but manually overridable for big announcements.

**User-created challenges** - this is doable but adds significant scope. Here's what it would require:

**Additional work for user challenges:**
1. **Approval workflow** - User-created challenges need mod review before going live (status: `Draft` → `Pending` → `Approved` → `Active`) @dev: they wouldn't need mod review.
   @ai: Got it - no mod gate. Challenges go live automatically once funded. Simplifies the flow significantly.

2. **Prize funding** - Who pays? Options:
   - User funds prizes from their Buzz balance (escrow on creation) @dev: Yeah, user would fund it.
   - Site-sponsored prizes only (users just create theme/rules)
   - Hybrid (user contributes, site matches)
   @ai: Clear - user escrows Buzz on creation. We'd deduct `prizePool + operationCost` upfront, refund unused operation budget after challenge ends.

3. **Create UI** - Form for users to set theme, duration, prize pool, required resources - @dev: They'd also need a UI for developing the prompt that gets used for judging entries and kind of testing that out. Obviously, that's not a small thing either. Probably a page of its own. In a way, I think that that probably should be, you know, part of the Create Experience, but then something that they can go and review at any time. probably they get a certain number of free checks, and then after that it starts to cost them buzz just to prevent abuse. The limit should be per user, not per challenge.
   @ai: This is interesting - a "Prompt Lab" for challenge creators. So:
   - User writes custom judging criteria/prompt
   - Can test it against sample images (their own or stock examples)
   - Free tier: 5 tests/day per user (tracked in `UserChallengeStats` or similar)
   - After that: costs Buzz per test
   - Prompt gets saved with the challenge and used by the review job
   This adds meaningful scope but makes user challenges way more powerful. Worth it.

4. **My Challenges page** - `/user/[username]/challenges` showing created + participated

5. **Moderation queue** - Mods need to review/approve user-submitted challenges. @dev: based on non-mod review. We have no model review needed, but we should be assessing the NSFW level of the challenge based on the model that they selected and the theme. Stuff like that. I think we'll need to have an LLM query that we run on what they've created that assigns an NSFW level.
   @ai: Makes sense - auto-NSFW classification via LLM at creation time. Inputs: model's existing NSFW level, theme text, custom prompt text. Output: challenge NSFW level (1-32 bitwise). This determines who sees the challenge in feeds.

6. **Entry management** - Can challenge creators moderate their own entries? Or only site mods? @dev: entries would still be reviewed by an AI agent. As part of the challenge configuration, they can define how many of the entries, what percentage of the entries are reviewed or whatever, so that, you know, more entries get reviewed. And then the cost for running the challenge kind of is driven by that. So there's the prize pool that they set up, and then there's the cost of actually creating the challenge.
   @ai: So challenge cost = `prizePool + (reviewBudget * costPerReview)`. User sets `reviewPercentage` (e.g., 50% of entries get scored) or `maxReviews` (e.g., up to 100 entries scored). The job respects this budget. Unused review budget could be refunded or rolled into bonus prizes.

**Rough estimate:**
- Core challenge system (no user creation): ~2-3 weeks
- Add user-created challenges: +2-3 weeks
- Total: ~4-6 weeks

**My suggestion:** Phase it. Ship the core system first (mod management, public feed, proper challenge pages). Then layer on user-created challenges once the foundation is solid. The schema can accommodate both from the start with a `createdById` field and `source` enum (`System` | `Mod` | `User`).
@dev: Agreed. Let's go ahead and shift the core system first, make sure that everything that we build supports the user-created stuff that we would be adding.

### API Endpoint

```typescript
// For theme preview widget
getUpcomingThemes(count: number): {
  date: string;
  theme: string;
  modelName: string;
  modelCreator: string;
}[]
```

---

## Job Modifications

### Modified Setup Job Flow

```typescript
async function createUpcomingChallenge() {
  const targetDate = getNextChallengeDate();

  // 1. Check for pre-prepared challenge
  const queued = await db.challengeQueue.findFirst({
    where: {
      scheduledDate: targetDate,
      status: 'Queued',
    },
    orderBy: { id: 'asc' },
  });

  if (queued) {
    // 2a. Create from queue
    const article = await createChallengeFromQueue(queued);
    await db.challengeQueue.update({
      where: { id: queued.id },
      data: { status: 'Active', articleId: article.id },
    });
    return article;
  }

  // 2b. Fall back to AI generation (existing logic)
  return createChallengeFromAI();
}

async function createChallengeFromQueue(queued: ChallengeQueue) {
  // Use queued.modelId or auto-select if null
  const model = queued.modelId
    ? await getModel(queued.modelId)
    : await selectRandomModel();

  // Use queued theme or generate if null
  const theme = queued.theme ?? await generateTheme(model);

  // Use queued content or generate
  const content = queued.customContent ?? await generateArticle({
    model,
    theme,
    titleOverride: queued.title,
    invitationOverride: queued.invitation,
  });

  // Create article and collection (existing logic)
  // ...
}
```

---

## Edit Permissions

### Who Can Edit?

@ai: I suggest any moderator can create/edit queued challenges, but **active challenges are locked** to prevent mid-contest changes.

Permissions:
- Create queued: Any mod
- Edit queued: Any mod
- Skip queued: Any mod
- Edit active: Locked (or admin-only with warning)

@dev: Yeah, active challenges should only be able to have like their title changed or something like that. Basic changes that won't impact how things are going in the competition.

### Audit Log

All changes should be logged:
```
[2026-01-13 14:30] @ModName created challenge for Jan 20 (theme: "Neon Dreams")
[2026-01-13 15:45] @ModName2 updated Jan 20 challenge (changed model)
[2026-01-14 10:00] System activated Jan 15 challenge
```

@dev: if we're going to open this up to everybody, I don't think that we need this.

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Create `ChallengeQueue` table and migration
- [ ] Create tRPC router with CRUD operations
- [ ] Modify setup job to check queue first

### Phase 2: Mod Interface
- [ ] Create `/moderator/challenges` page
- [ ] List view with create/edit/delete
- [ ] Model search integration
- [ ] Theme suggestion button (AI helper)

### Phase 3: Enhancements
- [ ] Calendar view
- [ ] Drag-to-reorder
- [ ] Bulk auto-fill action
- [ ] Preview before publish

### Phase 4: Public Preview
- [ ] Theme preview API
- [ ] UI widget for upcoming themes
- [ ] Visibility controls in config

---

## Open Questions

1. **Duplicate dates**: Prevent at creation, or allow and pick first?
2. **Approval workflow**: Single mod or require approval?
3. **Theme preview visibility**: How public should upcoming themes be?
4. **Edit active challenges**: Fully locked, or admin override?
5. **Audit detail level**: Full log or just timestamps?
6. **URL structure**: `/moderator/challenges` or elsewhere?

---

## Notes

@ai: Ready to start implementation once we align on the open questions. Let me know your thoughts inline with `@dev:` comments.
@dev: Okay, I asked for some pretty big changes here. What do you think?

@ai: Yeah, this has grown from "mod scheduling tool" into "full challenge platform". I think it's a good direction - challenges are clearly a big engagement driver and deserve first-class treatment rather than being shoehorned into Articles.

The expanded scope is achievable. Key decisions needed:
1. **Prize funding for user challenges** - This is the thorniest issue. Do users pay, site pays, or hybrid?
2. **Phase 1 vs full build** - Do you want to ship core system first, or build the whole thing?

I'll revise the schema below to accommodate the full vision. We can always build Phase 1 first and the schema will support adding user creation later.

---

## Revised Schema (Full Vision)

```prisma
model Challenge {
  id              Int       @id @default(autoincrement())

  // Timing
  startsAt        DateTime  // When challenge becomes active
  endsAt          DateTime  // When submissions close
  visibleAt       DateTime  // When challenge appears in public feed (default: 7 days before start)

  // Content
  title           String
  description     String?   // Markdown body (rules, theme explanation)
  theme           String?   // 1-2 word theme for display
  invitation      String?   // Short tagline
  coverImageId    Int?      // Challenge cover image
  nsfwLevel       Int       @default(1) // Bitwise NSFW level (auto-assessed by LLM)

  // Required resources (optional - null means any resource allowed)
  modelId         Int?      // Featured/required model
  modelVersionId  Int?      // Specific version required

  // Judging Configuration
  judgingPrompt   String?   // Custom prompt for AI judging (user-defined for user challenges)
  reviewPercentage Int      @default(100) // % of entries to score (affects cost)
  maxReviews      Int?      // Hard cap on reviews (alternative to percentage)

  // Entries
  collectionId    Int       // Collection holding submissions
  maxEntriesPerUser Int     @default(20)

  // Prizes & Costs
  prizes          Json      // [{place: 1, buzz: 5000, points: 150}, ...]
  entryPrize      Json?     // {buzz: 200, points: 10, minEntries: 10}
  prizePool       Int       @default(0) // Buzz escrowed for prizes
  operationBudget Int       @default(0) // Buzz escrowed for AI review costs
  operationSpent  Int       @default(0) // Actual Buzz spent on reviews

  // Ownership & Source
  createdById     Int
  source          ChallengeSource @default(System)

  // Lifecycle
  status          ChallengeStatus @default(Scheduled)

  // Metadata
  metadata        Json?     // Flexible field for challenge-type-specific data
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // Relations
  createdBy       User      @relation(fields: [createdById], references: [id])
  collection      Collection @relation(fields: [collectionId], references: [id])
  model           Model?    @relation(fields: [modelId], references: [id])
  coverImage      Image?    @relation(fields: [coverImageId], references: [id])
  entries         ChallengeEntry[]
  winners         ChallengeWinner[]
}

enum ChallengeSource {
  System    // Auto-generated by AI job
  Mod       // Created by moderator
  User      // Created by regular user
}

enum ChallengeStatus {
  Scheduled   // Funded and waiting for startsAt
  Active      // Currently accepting submissions
  Completed   // Winners announced
  Cancelled   // Cancelled before completion
}

// Note: Draft and Judging statuses were removed as they are not needed.
// Status transitions are controlled by dates and jobs, not manual input:
// - Challenges are created directly as Scheduled
// - Jobs automatically transition Scheduled → Active when startsAt is reached
// - Jobs automatically transition Active → Completed when endsAt is reached
// - Moderators can use quick actions to end challenges early or void them

model ChallengeEntry {
  id            Int       @id @default(autoincrement())
  challengeId   Int
  imageId       Int
  userId        Int

  // Scoring
  score         Json?     // {theme: 8, wittiness: 7, humor: 6, aesthetic: 9, total: 30}
  aiSummary     String?   // AI-generated description

  // Status
  status        ChallengeEntryStatus @default(Pending)
  reviewedAt    DateTime?
  reviewedById  Int?

  createdAt     DateTime  @default(now())

  // Relations
  challenge     Challenge @relation(fields: [challengeId], references: [id])
  image         Image     @relation(fields: [imageId], references: [id])
  user          User      @relation(fields: [userId], references: [id])

  @@unique([challengeId, imageId])
}

enum ChallengeEntryStatus {
  Pending     // Awaiting review
  Accepted    // Valid entry
  Rejected    // Invalid (wrong resource, NSFW, etc.)
  Scored      // AI has scored this entry
}

model ChallengeWinner {
  id            Int       @id @default(autoincrement())
  challengeId   Int
  userId        Int
  imageId       Int
  place         Int       // 1, 2, 3, etc.
  buzzAwarded   Int
  pointsAwarded Int
  reason        String?   // AI explanation for placement

  createdAt     DateTime  @default(now())

  // Relations
  challenge     Challenge @relation(fields: [challengeId], references: [id])
  user          User      @relation(fields: [userId], references: [id])
  image         Image     @relation(fields: [imageId], references: [id])

  @@unique([challengeId, place])
}
```

---

## Revised Implementation Phases

### Phase 1: Core Challenge System ✅
**Goal:** Replace Article-based challenges with dedicated Challenge entity + OpenRouter migration

- [ ] **OpenRouter migration** - Replace OpenAI SDK with OpenRouter SDK
  - Create abstraction layer for LLM calls
  - Support model selection per task type
  - Add fallback routing
- [x] Create `Challenge`, `ChallengeEntry`, `ChallengeWinner` tables
- [x] Deprecate Article-based challenges (new challenges no longer create Articles)
- [x] Create `/challenges` feed page (list view)
- [x] Create `/challenges/[id]` detail page
- [x] Update jobs to use new tables
- [x] Mod management at `/moderator/challenges` (list + CRUD)
- [ ] Auto-queue job to maintain 30-day horizon

### Phase 2: Enhanced Features
**Goal:** Multi-day challenges, visibility controls, better UX

- [ ] Support variable duration (`startsAt`/`endsAt`)
- [ ] `visibleAt` field for preview announcements
- [ ] Countdown timers on challenge cards
- [ ] Filter/sort options on feed (active, upcoming, completed)
- [ ] Challenge search
- [ ] NSFW auto-classification via LLM

### Phase 3: User-Created Challenges
**Goal:** Open challenge creation to users

- [ ] User challenge creation form
  - Theme, duration, prize pool configuration
  - Model/resource selection
  - Review budget slider (% of entries scored)
- [ ] **Prompt Lab** - Custom judging prompt editor
  - Write/edit judging criteria
  - Test against sample images
  - Free tier: 5 tests/day per user
  - Buzz cost for additional tests
- [ ] Prize + operation escrow system (Buzz deduction on creation)
- [ ] My Challenges page (`/user/[username]/challenges`)
- [ ] Challenge cost calculator (show estimated total before creation)
- [ ] Refund system for unused operation budget

### Phase 4: Polish
**Goal:** Engagement features

- [ ] `UserChallengeStats` table/view
- [ ] Leaderboard (most wins, most entries, highest scores)
- [ ] Streak tracking (consecutive challenges entered)
- [ ] Challenge history on user profiles
- [ ] Badges/achievements for milestones
- [ ] "Rematch" - challenge previous winners

@dev: as part of this overhaul. It probably makes sense to try and switch from the OpenAI-specific SDKs to the OpenRouter SDK. https://openrouter.ai/docs/quickstart.md

@ai: Good call. OpenRouter gives us:
- Model flexibility (GPT-4o, Claude, Gemini, open-source models) without code changes
- Fallback routing if one provider is down
- Cost optimization (route to cheaper models for simpler tasks)
- Single API key management

For challenges specifically, we could:
- Use GPT-4o or Claude for complex judging (winner selection)
- Use cheaper models (GPT-4o-mini, Haiku) for entry validation
- Let user-created challenges specify model preference (within budget)

I'll add this as a Phase 1 task since it affects the foundation.

---

## Implementation Status

> **Last Updated:** January 2026

### Phase 1: Core Challenge System ✅

The core challenge system has been implemented with the following components:

#### Database Schema
- `Challenge` table with timing, content, prizes, and lifecycle fields
- `ChallengeWinner` table for recording winners
- Challenge entries are stored as `CollectionItem` records in the challenge's collection

#### Challenge Lifecycle
Status transitions are **automatic and date-driven**, not manually controlled:

```
Scheduled → Active → Completed
    ↓          ↓
Cancelled  Cancelled
```

**Final ChallengeStatus enum:**
- `Scheduled` - Challenge is funded and waiting for `startsAt`
- `Active` - Currently accepting submissions (between `startsAt` and `endsAt`)
- `Completed` - Challenge ended, winners announced
- `Cancelled` - Challenge was voided before completion

**Removed statuses:**
- `Draft` - Not needed since challenges are created directly as Scheduled
- `Judging` - Not needed since winner picking happens immediately at challenge end

#### Moderator Quick Actions
Instead of manual status changes, moderators have contextual quick actions:

| Status | Available Actions |
|--------|-------------------|
| Scheduled | Cancel Challenge |
| Active | End & Pick Winners, Void Challenge |
| Completed | (none - terminal state) |
| Cancelled | (none - terminal state) |

**End & Pick Winners:**
- Closes the collection
- Runs LLM-based winner selection
- Awards winner prizes (yellow Buzz)
- Awards entry participation prizes to eligible non-winners (blue Buzz)
- Stores completion summary in `Challenge.metadata.completionSummary`
- Sends notifications to winners and entry prize recipients
- Sets status to `Completed`

**Void Challenge:**
- Closes the collection
- Does NOT pick winners or award prizes
- Sets status to `Cancelled`

#### Completion Summary Storage

When a challenge completes (either via job or manual action), the AI-generated judging content is stored:

```typescript
Challenge.metadata.completionSummary = {
  judgingProcess: string;  // HTML describing the judging process
  outcome: string;         // HTML summary of the challenge outcome
  completedAt: string;     // ISO timestamp
};
```

This content is displayed on the challenge detail page in the Winners section.

**Note:** Challenges no longer create or update Articles. The Article-based system has been fully deprecated:
- New challenges are created directly in the `Challenge` table
- Cooldown tracking uses the `Challenge` table (not Article metadata)
- Admin/mod endpoints use Challenge IDs (not Article IDs)
- The `getChallengeDetails` function (Article-based) is deprecated; use `getChallengeById` instead

#### Multi-Challenge Job Processing
The daily challenge jobs support **multiple concurrent active challenges**:

- `reviewEntries()` - Processes ALL active challenges, not just one
- `pickWinners()` - Handles ended challenges (winner picking) and starts scheduled challenges
- Each challenge is processed independently with error isolation (one failure doesn't stop others)
- System challenges are auto-created only when no upcoming system challenges exist

**Key helper functions:**
- `getActiveChallenges()` - Returns all active challenges
- `getEndedActiveChallenges()` - Returns active challenges past their `endsAt`
- `getChallengesReadyToStart()` - Returns scheduled challenges ready to activate
- `getUpcomingSystemChallenge()` - Checks if a system challenge exists

#### Key Files
- Schema: `prisma/schema.full.prisma` (Challenge, ChallengeWinner models)
- Types: `src/server/schema/challenge.schema.ts` (ChallengeDetail, ChallengeCompletionSummary)
- Service: `src/server/services/challenge.service.ts`
- Router: `src/server/routers/challenge.router.ts`
- Moderator UI: `src/pages/moderator/challenges.tsx`
- Challenge Detail Page: `src/pages/challenges/[id]/[[...slug]].tsx`
- Create/Edit Form: `src/components/Challenge/ChallengeUpsertForm.tsx`
- Daily Job: `src/server/jobs/daily-challenge-processing.ts`
- Challenge Helpers: `src/server/games/daily-challenge/challenge-helpers.ts`
- Challenge Utils: `src/server/games/daily-challenge/daily-challenge.utils.ts`

### Phase 2-4: Future Work
- [ ] User-created challenges
- [ ] Prompt Lab for custom judging criteria
- [ ] UserChallengeStats and leaderboards
- [ ] Streak tracking and badges

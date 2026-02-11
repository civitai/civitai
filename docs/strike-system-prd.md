# Strike System - Phase 1 PRD (Backend Infrastructure)

**ClickUp Task**: https://app.clickup.com/t/868hctmjw
**PR**: https://github.com/civitai/civitai/pull/2019
**Status**: In Progress — backend implementation complete, testing in progress
**Priority**: Critical (Foundation for moderation enforcement)
**Due**: Feb 10, 2026

---

## Context

Civitai currently has binary moderation tools: mute or ban. There's no graduated enforcement system that warns users, tracks repeat offenders, or auto-escalates consequences. The team agreed we need a **strike system** that:

- Gives users clear, time-limited warnings before escalating to mutes/bans
- Provides mods with a structured enforcement workflow
- Creates an audit trail of user violations
- Automatically expires strikes so users aren't punished forever

Phase 1 focuses entirely on **backend infrastructure** (DB schema, services, tRPC endpoints, jobs, notifications). Frontend/UI is Phase 2.

---

## Business Rules

From the ClickUp task and team discussion:

| Rule | Detail |
|------|--------|
| Strike per blocked content | 1 point per incident (max 1 auto-strike per day per user) |
| Severe content (realistic + minor + R+) | 3 points for a single incident |
| 2 active points | Auto-mute for 3 days |
| 3 active points | Muted + flagged for LLM/mod review |
| Strike expiration | 30 days from creation |

### What we are NOT building yet:
- Auto-strikes from image scan/blocking (too many false positives — blocked content goes to review queue for manual evaluation)
- Formal appeal system UI (appeals go through support)
- Automated trigger points from reports/scans (build the system first, wire triggers later)

---

## Design Decisions

### Points-based model (not just count)
Each strike record has a `points` field (1-3). A severe violation creates one record worth 3 points. Escalation checks sum of active points. This preserves the semantic connection between one violation and one strike record while supporting variable severity.

### New `StrikeReason` enum (not reusing `BanReasonCode`)
Ban reasons are specific to banning (SexualMinor, Nudify, etc.). Strike reasons need different granularity (BlockedContent, TOSViolation, ManualModAction). Keeping them separate lets each evolve independently.

### `muteExpiresAt` column on User
Current mute is boolean. Adding `muteExpiresAt` (nullable DateTime) enables timed mutes without breaking existing manual mutes. An hourly job checks and auto-unmutes when the expiration passes.

### Voided (not deleted) for overturned strikes
When a mod overturns a strike, it gets status `Voided` rather than deleted, preserving the audit trail.

---

## Database Schema

### New Enums

```prisma
enum StrikeReason {
  BlockedContent
  RealisticMinorContent
  CSAMContent
  TOSViolation
  HarassmentContent
  ProhibitedContent
  ManualModAction
}

enum StrikeStatus {
  Active
  Expired
  Voided
}
```

### New Model: `UserStrike`

```prisma
model UserStrike {
  id              Int           @id @default(autoincrement())
  userId          Int
  user            User          @relation("userStrikes", fields: [userId], references: [id], onDelete: Cascade)

  reason          StrikeReason
  status          StrikeStatus  @default(Active)
  points          Int           @default(1)

  description     String        // User-facing explanation (critical per team discussion)
  internalNotes   String?       // Mod-only notes
  entityType      EntityType?   // What content triggered it
  entityId        Int?
  reportId        Int?          // Link to originating report

  createdAt       DateTime      @default(now())
  expiresAt       DateTime      // Default: createdAt + 30 days
  voidedAt        DateTime?
  voidedBy        Int?
  voidedByUser    User?         @relation("voidedStrikes", fields: [voidedBy], references: [id], onDelete: SetNull)
  voidReason      String?

  issuedBy        Int?
  issuedByUser    User?         @relation("issuedStrikes", fields: [issuedBy], references: [id], onDelete: SetNull)

  @@index([userId, status])
  @@index([userId, expiresAt])
  @@index([status])
  @@index([createdAt])
}
```

### User Model Changes

Add to `User`:
```prisma
strikes           UserStrike[]  @relation("userStrikes")
issuedStrikes     UserStrike[]  @relation("issuedStrikes")
voidedStrikes     UserStrike[]  @relation("voidedStrikes")
muteExpiresAt     DateTime?
```

Add to `UserMeta` schema (`src/server/schema/user.schema.ts`):
```typescript
strikeFlaggedForReview: z.boolean().optional(),
strikeFlaggedAt: z.date().optional(),
```

---

## File-by-File Implementation Plan

### 1. Schema & Migration

**Files:**
- `prisma/schema.prisma` — Add enums, `UserStrike` model, User relations, `muteExpiresAt`
- `prisma/migrations/<timestamp>_add_strike_system/migration.sql` — DDL for new types, table, indexes, FK constraints, alter User

**Migration SQL:**
```sql
CREATE TYPE "StrikeReason" AS ENUM (
  'BlockedContent', 'RealisticMinorContent', 'CSAMContent',
  'TOSViolation', 'HarassmentContent', 'ProhibitedContent', 'ManualModAction'
);
CREATE TYPE "StrikeStatus" AS ENUM ('Active', 'Expired', 'Voided');

CREATE TABLE "UserStrike" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "reason" "StrikeReason" NOT NULL,
  "status" "StrikeStatus" NOT NULL DEFAULT 'Active',
  "points" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT NOT NULL,
  "internalNotes" TEXT,
  "entityType" "EntityType",
  "entityId" INTEGER,
  "reportId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "voidedAt" TIMESTAMP(3),
  "voidedBy" INTEGER,
  "voidReason" TEXT,
  "issuedBy" INTEGER,
  CONSTRAINT "UserStrike_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "User" ADD COLUMN "muteExpiresAt" TIMESTAMP(3);

CREATE INDEX "UserStrike_userId_status_idx" ON "UserStrike"("userId", "status");
CREATE INDEX "UserStrike_userId_expiresAt_idx" ON "UserStrike"("userId", "expiresAt");
CREATE INDEX "UserStrike_status_idx" ON "UserStrike"("status");
CREATE INDEX "UserStrike_createdAt_idx" ON "UserStrike"("createdAt");

ALTER TABLE "UserStrike" ADD CONSTRAINT "UserStrike_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserStrike" ADD CONSTRAINT "UserStrike_voidedBy_fkey"
  FOREIGN KEY ("voidedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserStrike" ADD CONSTRAINT "UserStrike_issuedBy_fkey"
  FOREIGN KEY ("issuedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

### 2. Zod Schemas — `src/server/schema/strike.schema.ts` (NEW)

Input validation schemas for all tRPC endpoints:

| Schema | Purpose |
|--------|---------|
| `createStrikeSchema` | Mod issues a strike (userId, reason, points, description, entityType?, entityId?, reportId?, expiresInDays) |
| `voidStrikeSchema` | Mod voids a strike (strikeId, voidReason) |
| `getStrikesSchema` | Mod queries strikes (userId?, username?, status?, reason?, pagination) |
| `getMyStrikesSchema` | User views own strikes (includeExpired flag) |

### 3. Service Layer — `src/server/services/strike.service.ts` (NEW)

Core business logic. Key functions:

```typescript
// CRUD
createStrike(input & { issuedBy?: number }) → UserStrike
voidStrike(input & { voidedBy: number }) → UserStrike

// Queries
getActiveStrikePoints(userId) → number
getStrikesForUser(userId, opts?) → StrikeSummary
getStrikesForMod(filters, pagination) → PaginatedStrikes

// Escalation engine
evaluateStrikeEscalation(userId) → { totalPoints, action }

// Rate limiting
shouldRateLimitStrike(userId) → boolean  // max 1 auto-strike/day

// Jobs
expireStrikes() → { expiredCount }
processTimedUnmutes() → { unmutedCount }
```

#### Escalation Logic (inside `evaluateStrikeEscalation`):

```
1. Sum active points: SELECT SUM(points) FROM UserStrike WHERE userId=X AND status='Active'
2. Threshold check (descending):
   - >= 3 points: mute (indefinite, muteExpiresAt=null) + set meta.strikeFlaggedForReview=true → notify
   - >= 2 points: mute for 3 days (set muteExpiresAt = now+3d, resets if already muted) → notify
   - < 2 points: no action
3. invalidateSession(userId) after any mute
4. Mute stacking: if already timed-muted, reset muteExpiresAt to now+3d on each new 2pt escalation
```

#### Rate Limiting (inside `shouldRateLimitStrike`):
```sql
SELECT COUNT(*) FROM "UserStrike"
WHERE "userId" = $1 AND "createdAt" >= CURRENT_DATE AND "reason" != 'ManualModAction'
```
**Only applies to automated/system strikes.** Manual mod strikes (`ManualModAction`) always bypass the daily limit. Mods can issue as many manual strikes as needed.

#### Mute Stacking
If a user is already muted (from a previous escalation) and receives another strike, the mute timer **resets to 3 days from now**. This means repeat offenders during an active mute get their punishment extended. If the new total reaches 3+ points, the mute becomes indefinite + flagged for review (overriding the timed mute).

### 4. Controller — `src/server/controllers/strike.controller.ts` (NEW)

Thin handlers following existing pattern (e.g., `src/server/controllers/user.controller.ts`):

| Handler | Procedure | Description |
|---------|-----------|-------------|
| `createStrikeHandler` | `moderatorProcedure` | Issue strike, run escalation, send notifications |
| `voidStrikeHandler` | `moderatorProcedure` | Void strike, re-evaluate escalation |
| `getStrikesHandler` | `moderatorProcedure` | List/filter all strikes |
| `getUserStrikeHistoryHandler` | `moderatorProcedure` | Full strike history for a user |
| `getMyStrikesHandler` | `protectedProcedure` | User views own active strikes |
| `getMyStrikeSummaryHandler` | `protectedProcedure` | User's standing summary (points, next expiry) |

### 5. Router — `src/server/routers/strike.router.ts` (NEW)

```typescript
export const strikeRouter = router({
  // User endpoints
  getMyStrikes: protectedProcedure.input(getMyStrikesSchema).query(getMyStrikesHandler),
  getMyStrikeSummary: protectedProcedure.query(getMyStrikeSummaryHandler),

  // Mod endpoints
  create: moderatorProcedure.input(createStrikeSchema).mutation(createStrikeHandler),
  void: moderatorProcedure.input(voidStrikeSchema).mutation(voidStrikeHandler),
  getAll: moderatorProcedure.input(getStrikesSchema).query(getStrikesHandler),
  getUserHistory: moderatorProcedure.input(z.object({ userId: z.number() })).query(getUserStrikeHistoryHandler),
});
```

### 6. Router Registration — `src/server/routers/index.ts`

Add `strike: strikeRouter` to the `appRouter`.

### 7. Notifications — `src/server/notifications/strike.notifications.ts` (NEW)

Following pattern from `src/server/notifications/system.notifications.ts`:

| Type | When | toggleable |
|------|------|------------|
| `strike-issued` | After createStrike() | `false` |
| `strike-voided` | After voidStrike() | `false` |
| `strike-escalation-muted` | When escalation triggers mute | `false` |
| `strike-expired` | When expiration job runs | `false` |

All link to `/user/account#strikes` (Phase 2 page).

### 8. Notification Registration — `src/server/notifications/utils.notifications.ts`

Add `import { strikeNotifications }` and spread into `notificationProcessors`.

### 9. Email Template — `src/server/email/templates/strikeIssued.email.ts` (NEW)

Following pattern from existing email templates in `src/server/email/templates/`. Includes:
- Strike reason and description
- Points issued and total active points
- Expiration date
- Link to account standing page

### 10. Jobs — `src/server/jobs/process-strikes.ts` (NEW)

Two jobs:

| Job | Cron | Logic |
|-----|------|-------|
| `expire-strikes` | `0 2 * * *` (daily 2AM) | Set expired strikes to `Expired` status, optionally notify users |
| `process-timed-unmutes` | `0 * * * *` (hourly) | Unmute users whose `muteExpiresAt` has passed, refresh sessions |

### 11. Job Registration — `src/pages/api/webhooks/run-jobs/[[...run]].ts`

Import and add both jobs to the `jobs` array.

### 12. UserMeta Update — `src/server/schema/user.schema.ts`

Add `strikeFlaggedForReview` and `strikeFlaggedAt` fields to the `userMeta` zod schema.

---

## Integration Points

### With Existing Mute System
- Strike-based mutes use `muteExpiresAt` for timed mutes (3 days)
- Existing manual mutes (`toggleMute`) remain unchanged — they have no expiration
- The `confirm-mutes` job (`src/server/jobs/confirm-mutes.ts`) is unaffected — it handles subscription cancellation for confirmed mutes, which is a separate concern
- Auto-unmute happens via the new `process-timed-unmutes` job

### With Reports
- `createStrike` accepts optional `reportId` to link strike to the originating report
- No automatic strike from report actioning in Phase 1 — mods issue strikes manually
- Future: When a mod actions a report, the UI can offer a "Issue Strike" button

### With User Score
- Existing `reportsAgainst` score in `update-user-score.ts` continues to track TOS violations independently
- Phase 2 can integrate strikes into score calculation

### With Session/Auth
- `invalidateSession(userId)` called after any escalation that mutes
- `refreshSession(userId)` called after timed unmute lifts

---

## Implementation Sequence

```
Step 1: Schema + Migration
  └─ prisma/schema.prisma
  └─ prisma/migrations/...
  └─ pnpm run db:generate

Step 2 (parallel):
  ├─ src/server/schema/strike.schema.ts
  ├─ src/server/notifications/strike.notifications.ts
  └─ src/server/email/templates/strikeIssued.email.ts

Step 3: src/server/services/strike.service.ts
  └─ depends on: schema, Prisma types

Step 4: src/server/controllers/strike.controller.ts
  └─ depends on: service

Step 5: src/server/routers/strike.router.ts
  └─ depends on: controller, schema

Step 6 (parallel):
  ├─ src/server/routers/index.ts (register router)
  ├─ src/server/notifications/utils.notifications.ts (register notifications)
  ├─ src/server/schema/user.schema.ts (UserMeta update)
  └─ src/server/jobs/process-strikes.ts

Step 7: src/pages/api/webhooks/run-jobs/[[...run]].ts (register jobs)

Step 8: Typecheck + lint
  └─ pnpm run typecheck && pnpm run lint
```

---

## Verification Plan

1. **Typecheck**: `pnpm run typecheck` — all new files compile without errors
2. **Lint**: `pnpm run lint` — no linting issues
3. **DB Migration**: Run migration against local DB, verify table and indexes created
4. **Prisma Generate**: `pnpm run db:generate` — types available for UserStrike
5. **Manual API testing** (via dev server):
   - Call `strike.create` as mod → verify strike record created, notification sent
   - Call `strike.getMyStrikes` as user → verify returns own strikes
   - Call `strike.void` as mod → verify strike status changed to Voided
   - Issue 2+ points → verify auto-mute triggered
   - Issue 3+ points → verify flaggedForReview set in meta
6. **Job testing**: Manually trigger `expire-strikes` and `process-timed-unmutes` via the run-jobs webhook

---

## Implementation Status

### Done
- [x] Prisma schema + migration (enums, `UserStrike` model, `muteExpiresAt` on User)
- [x] Zod input schemas (`strike.schema.ts`)
- [x] Service layer with all business logic (`strike.service.ts`)
- [x] Controller handlers (`strike.controller.ts`)
- [x] tRPC router with mod + user endpoints (`strike.router.ts`)
- [x] Router registered in `index.ts`
- [x] 5 notification types: `strike-issued`, `strike-voided`, `strike-escalation-muted`, `strike-expired`, `strike-de-escalation-unmuted`
- [x] Email template for strike issued
- [x] Cron jobs: `expire-strikes` (daily 2AM), `process-timed-unmutes` (hourly)
- [x] Jobs registered in `run-jobs`
- [x] `strikeFlaggedForReview` / `strikeFlaggedAt` added to `UserMeta`
- [x] Code review (2 rounds) — all critical/high/medium issues resolved

### Code Review Fixes Applied
1. **De-escalation unmutes users** — else branch in `evaluateStrikeEscalation` handles unmuting when points drop
2. **processTimedUnmutes re-checks points** — calls `evaluateStrikeEscalation` before unmuting
3. **internalNotes protected** — `getStrikesForUser` uses `select` with `includeInternalNotes` param
4. **voidStrike validates state** — atomic `updateMany` with status guard prevents race conditions
5. **Notification text handles indefinite** — conditional message for indefinite vs timed mute
6. **Notification errors handled internally** — `createNotification` catches and logs to Axiom; strike service doesn't need its own try-catch around notification calls
7. **strikeFlaggedForReview cleared** — on de-escalation and when points drop from 3+ to 2
8. **expireStrikes re-evaluates** — calls `evaluateStrikeEscalation` per affected user after expiring
9. **User existence validated** — `createStrike` checks user exists before any work
10. **Duplicate mute notifications skipped** — checks if already muted at same threshold
11. **De-escalation unmute notification** — users notified when their mute is lifted

### In Progress
- [x] Test webhook endpoint (`src/pages/api/testing/strikes.ts`) for manual integration testing with dryRun support

### TODO (Phase 1 remaining)
- [ ] Run migration on dev/staging DB + `pnpm run db:generate`
- [ ] Typecheck + lint pass (blocked on Prisma client generation)
- [ ] Manual smoke test via test webhook endpoint (see Testing section below)
- [ ] QA sign-off

---

## Testing

### Test Webhook Endpoint

`GET /api/testing/strikes?token=WEBHOOK_TOKEN&action=...`

Secured via `WebhookEndpoint` (same as daily-challenge testing endpoint). Supports `dryRun=true` for safe inspection of what _would_ happen without mutating the DB.

#### Read-Only Actions (always safe)

| Action | Params | Returns |
|--------|--------|---------|
| `get-user-strikes` | `userId` | All strikes for user, active points, next expiry |
| `get-active-points` | `userId` | Sum of active strike points |
| `check-rate-limit` | `userId` | Whether auto-strike would be rate limited today |

#### Mutating Actions (use `dryRun=true` for safe preview)

| Action | Params | Dry Run Returns | Live Effect |
|--------|--------|----------------|-------------|
| `evaluate-escalation` | `userId` | Current state + predicted action | Actually escalates/de-escalates |
| `create` | `userId`, `reason`, `description`, `points?`, `expiresInDays?` | Validates user, checks rate limit, previews strike | Creates strike + evaluates escalation |
| `void` | `strikeId`, `voidReason?` | Looks up strike, checks if voidable | Voids strike + re-evaluates |
| `expire` | _(none)_ | Lists strikes that would expire | Expires them + notifies + re-evaluates |
| `unmute` | _(none)_ | Lists users with expired mutes + predicted outcomes | Processes unmutes |

#### Example Smoke Test Sequence

```bash
TOKEN=your_webhook_token
BASE=http://localhost:3000/api/testing/strikes

# 1. Check a user's current state
curl "$BASE?token=$TOKEN&action=get-user-strikes&userId=123"
curl "$BASE?token=$TOKEN&action=get-active-points&userId=123"

# 2. Dry run a strike creation
curl "$BASE?token=$TOKEN&action=create&userId=123&reason=ManualModAction&points=1&description=Test+strike&dryRun=true"

# 3. Actually create a strike
curl "$BASE?token=$TOKEN&action=create&userId=123&reason=ManualModAction&points=1&description=Test+strike"

# 4. Check escalation state
curl "$BASE?token=$TOKEN&action=evaluate-escalation&userId=123&dryRun=true"

# 5. Create a second strike (should trigger 2-point mute)
curl "$BASE?token=$TOKEN&action=create&userId=123&reason=ManualModAction&points=1&description=Second+test+strike"

# 6. Verify mute was applied
curl "$BASE?token=$TOKEN&action=evaluate-escalation&userId=123&dryRun=true"

# 7. Void the second strike (should de-escalate / unmute)
curl "$BASE?token=$TOKEN&action=void&strikeId=STRIKE_ID&voidReason=Testing"

# 8. Verify de-escalation
curl "$BASE?token=$TOKEN&action=evaluate-escalation&userId=123&dryRun=true"

# 9. Void the first strike to clean up
curl "$BASE?token=$TOKEN&action=void&strikeId=FIRST_STRIKE_ID&voidReason=Cleanup"
```

### Cron Jobs

Jobs are already testable via the existing job runner:

```bash
# Expire strikes (normally runs daily at 2AM)
GET /api/webhooks/run-jobs?run=expire-strikes&token=WEBHOOK_TOKEN

# Process timed unmutes (normally runs hourly)
GET /api/webhooks/run-jobs?run=process-timed-unmutes&token=WEBHOOK_TOKEN
```

---

## Phase 2 Preview (Frontend — NOT in this phase)

- User Account Standing page at `/user/account#strikes`
- Mod dashboard: strike log, filterable by user, issue/void UI
- "Issue Strike" button in report actioning flow
- Score integration on the standing page
- Notification links working end-to-end

---

## Key Reference Files

| Purpose | File |
|---------|------|
| Prisma schema | `prisma/schema.prisma` |
| User model & meta | `src/server/schema/user.schema.ts` (line 323) |
| tRPC middleware | `src/server/trpc.ts` (moderatorProcedure, protectedProcedure) |
| Router registration | `src/server/routers/index.ts` |
| Report service (pattern ref) | `src/server/services/report.service.ts` |
| User service (ban/mute) | `src/server/services/user.service.ts` |
| User controller (mute handler) | `src/server/controllers/user.controller.ts` |
| Notification pattern | `src/server/notifications/system.notifications.ts` |
| Notification registry | `src/server/notifications/utils.notifications.ts` |
| Job pattern | `src/server/jobs/confirm-mutes.ts` |
| Job registration | `src/pages/api/webhooks/run-jobs/[[...run]].ts` |
| Email templates | `src/server/email/templates/` |
| Session invalidation | `src/server/auth/session-invalidation.ts` |
| Existing enums | `src/server/common/enums.ts`, `src/shared/utils/prisma/enums` |
| Test webhook endpoint | `src/pages/api/testing/strikes.ts` |
| Test pattern reference | `src/pages/api/testing/daily-challenge.ts` |

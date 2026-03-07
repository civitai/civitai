# Approval Request System

When an agent determines that a moderation action is needed but falls outside its auto-action bounds (see [bounds.md](bounds.md)), it submits an **approval request** for human review. This document covers the data schema, UI, API endpoints, and codebase references.

## Concept

Agents do work autonomously within defined bounds. For high-stakes actions (bans, NCMEC reports, content blocking on popular creators, etc.), the agent prepares everything and submits a request. A human moderator reviews the agent's reasoning and evidence, then approves or rejects.

The agent's session pauses until a decision is made. On approval, the agent executes the action. On rejection, the agent receives the rejection reason and can adjust its approach.

@dev: How should the agent "pause"? Options: (1) webhook callback when decision is made, (2) agent polls for status, (3) agent session is suspended and resumed on decision. Which fits best with the agent runner architecture?

---

## Data Schema

### ApprovalRequest table

```prisma
model ApprovalRequest {
  id              Int       @id @default(autoincrement())
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // What the agent wants to do
  action          String    // e.g., "ban-user", "block-content", "report-ncmec"
  entityType      String?   // e.g., "user", "model", "image"
  entityId        Int?
  targetUserId    Int?

  // Agent's reasoning
  summary         String    // Short description of the action
  reasoning       String    @db.Text  // Agent's full reasoning/evidence
  evidence        Json?     // Structured evidence (image URLs, scan results, etc.)

  // Safe materials for review (no raw CSAM, etc.)
  safePreviewUrl  String?   // Blurred/safe version of content
  reviewUrl       String?   // Link to entity in moderator UI

  // Agent session tracking
  agentSessionId  String    // To resume the agent on decision
  agentType       String    // Which agent submitted this (e.g., "image-review", "training-review")

  // Decision
  status          ApprovalRequestStatus @default(Pending)
  decidedAt       DateTime?
  decidedBy       Int?      // Moderator userId
  decidedByUser   User?     @relation(fields: [decidedBy], references: [id])
  rejectionReason String?

  // Proposed action params (stored so execution is exact)
  actionParams    Json      // The exact params to pass to the skill on approval
}

enum ApprovalRequestStatus {
  Pending
  Approved
  Rejected
  Expired    // Auto-expired after timeout (e.g., 24h)
  Cancelled  // Agent cancelled the request
}
```

### Key design decisions

- **`actionParams`**: Stores the exact skill input so the action executes identically to what was proposed. No ambiguity.
- **`reasoning`**: Agent's chain-of-thought or summary — lets the moderator understand *why* without re-investigating.
- **`evidence`**: Structured data (scan results, user history summary, etc.) for quick review.
- **`safePreviewUrl`**: For NCMEC cases, this is the blurred image. The moderator never sees raw CSAM.
- **`agentSessionId`**: Links back to the agent session so it can be resumed or notified.

---

## API Endpoints

### Submit approval request (agent-facing)

```
POST /api/trpc/approvalRequest.create
```

**Input:**
```typescript
{
  action: string;
  entityType?: string;
  entityId?: number;
  targetUserId?: number;
  summary: string;
  reasoning: string;
  evidence?: object;
  safePreviewUrl?: string;
  reviewUrl?: string;
  agentSessionId: string;
  agentType: string;
  actionParams: object;
}
```

**Output:** `{ id: number, status: 'Pending' }`

### List pending requests (moderator-facing)

```
POST /api/trpc/approvalRequest.getAll
```

**Input:**
```typescript
{
  status?: ApprovalRequestStatus;
  agentType?: string;
  page?: number;
  limit?: number;
}
```

### Decide on request (moderator-facing)

```
POST /api/trpc/approvalRequest.decide
```

**Input:**
```typescript
{
  id: number;
  decision: 'Approved' | 'Rejected';
  rejectionReason?: string;
}
```

**Side effects on approval:**
1. Update `status` to `Approved`, set `decidedAt`, `decidedBy`
2. Execute the action using `actionParams` (call the appropriate skill)
3. Notify the agent session (webhook/resume)

**Side effects on rejection:**
1. Update `status` to `Rejected`, set `rejectionReason`
2. Notify the agent session with the rejection reason

### Check request status (agent-facing)

```
POST /api/trpc/approvalRequest.getStatus
```

**Input:** `{ id: number }`
**Output:** `{ status, decidedAt?, rejectionReason? }`

---

## UI

### Moderator queue page

**Location:** `/moderator/approval-requests` (new page)

The UI is a queue-based review interface, similar to the existing reports page at `/moderator/reports` and the generation-restrictions page at `/moderator/generation-restrictions`.

**Layout:**
- Filter bar: status (Pending/Approved/Rejected), agent type, action type
- Table/list of requests, sorted by `createdAt desc` (newest first for pending, oldest first as option)
- Each row shows: action type badge, entity summary, agent type, time submitted
- Click to expand: full reasoning, evidence, safe preview, action params
- Approve/Reject buttons with optional rejection reason

**Key UX:**
- Pending count badge in the moderator nav (like unread notifications)
- NCMEC requests highlighted with a distinct badge/color (always-approve-required)
- Bulk approve for low-risk actions (e.g., muting users with clear evidence)
- Rejection requires a reason (feeds back to the agent)

### Wireframe

```
+--------------------------------------------------------------+
| Approval Requests                    [Pending: 12] [All]     |
+--------------------------------------------------------------+
| Filter: [Status ▼] [Agent Type ▼] [Action ▼]    [Search]    |
+--------------------------------------------------------------+
| ⬤ ban-user    | User #12345 | image-review-agent | 5m ago   |
|   Summary: User posted CSAM in training data                 |
|   [View Details] [Approve] [Reject]                          |
+--------------------------------------------------------------+
| ⬤ block-model | Model #678  | model-review-agent | 12m ago  |
|   Summary: Model generates realistic CSAM-like content       |
|   [View Details] [Approve] [Reject]                          |
+--------------------------------------------------------------+
| ...                                                          |
+--------------------------------------------------------------+
```

### Detail view (expanded)

```
+--------------------------------------------------------------+
| Action: ban-user                                             |
| Target: User #12345 (username)          [View Profile →]     |
| Agent: image-review-agent               Session: abc-123     |
| Submitted: 2025-01-15 14:30                                  |
+--------------------------------------------------------------+
| Agent's Reasoning:                                           |
| User uploaded 3 training datasets containing images with     |
| captions describing minors. Scan results show isMinor=true   |
| on 7 of 50 images. User account is 2 days old with no       |
| legitimate content. Recommend ban with SexualMinorTraining.  |
+--------------------------------------------------------------+
| Evidence:                                                    |
| • Scan results: 7/50 images flagged (isMinor confidence >0.8)|
| • Training captions: [expand to view]                        |
| • Account age: 2 days                                        |
| • Prior violations: 0                                        |
+--------------------------------------------------------------+
| Safe Preview: [blurred image]                                |
+--------------------------------------------------------------+
| Action Params:                                               |
| { userId: 12345, reasonCode: "SexualMinorTraining" }         |
+--------------------------------------------------------------+
|                        [Approve] [Reject with reason...]     |
+--------------------------------------------------------------+
```

---

## Codebase References

Existing patterns to draw from when building this:

### Report moderation queue (closest analog for table-based UI)

- **Page**: `src/pages/moderator/reports.tsx`
- **Router**: `src/server/routers/report.router.ts`
  - `report.getAll` — paginated list with filters
  - `report.setStatus` — moderator decision (Actioned/Unactioned)
  - `report.update` — update internal notes
- **Schema**: `src/server/schema/report.schema.ts`
  - `getReportsSchema` — pagination, filters
  - `setReportStatusSchema` — `{ ids, status }`
  - `updateReportSchema` — `{ id, status, internalNotes }`
- **Service**: `src/server/services/report.service.ts`
  - `bulkSetReportStatus()` — handles side effects (rewards, tracking)
- **Data model** (Prisma lines 1121-1148): `id`, `userId`, `reason` (enum), `createdAt`, `details` (JSON), `internalNotes`, `previouslyReviewedCount`, `alsoReportedBy` (int[]), `status`, `statusSetAt`, `statusSetBy`
- **UI pattern**: MantineReactTable with column filters/sorting. Row click opens a `<Drawer>` (side panel) for detail view. Menu-based status toggle. Optimistic updates via `queryClient.setQueriesData`.

### Generation restrictions page (closest analog for two-panel layout)

- **Page**: `src/pages/moderator/generation-restrictions.tsx`
- **Router**: `src/server/routers/user-restriction.router.ts`
  - `userRestriction.getAll` — paginated list with status/username/userId filters
  - `userRestriction.resolve` — moderator decision (Upheld/Overturned)
  - `userRestriction.saveSuspiciousMatches` — flag specific trigger items
- **Schema**: `src/server/schema/user-restriction.schema.ts`
  - `resolveRestrictionSchema: { userRestrictionId, status, resolvedMessage? }`
- **Data model**: `id`, `userId`, `status` (Pending/Upheld/Overturned), `triggers[]` (prompt, source, category, matchedWord, matchedRegex, imageId, time), `createdAt`, `resolvedAt`, `resolvedBy`, `resolvedMessage`, `userMessage`, `userMessageAt`
- **UI pattern**: Two-panel split layout — left panel (500px fixed) is a scrollable list, right panel (flex-1) shows detail. Uses Zustand `createSelectStore` for selection state. Conditional action buttons based on status. `logToAxiom()` for audit logging. `createNotification()` to notify user of resolution.

**This is the best reference for the approval request UI**, since it's a decision queue with Pending/Upheld/Overturned states — directly analogous to Pending/Approved/Rejected.

### Moderator page conventions

- Moderator pages live under `src/pages/moderator/`
- Table library: `MantineReactTable` for tabular data with filters, sorting, pagination
- Feature flag gating via `useFeatureFlags()`
- All moderator endpoints use `moderatorProcedure` (role check)
- Pagination state stored in URL query params
- Audit logging via `logToAxiom()` with structured event data
- User notifications via `createNotification()` (async, with category and deduplication key)
- Other moderator queue pages for reference: `buzz-withdrawal-requests.tsx`, `orchestrator/flagged.tsx`, `image-rating-review.tsx`, `downleveled-review.tsx`, `duplicate-hashes.tsx`

### CSAM report flow (for NCMEC approval requests)

- **Page**: `src/pages/moderator/csam/index.tsx`
- **Router**: `src/server/routers/csam.router.ts`
  - `csam.getCsamReports` — paginated list
  - `csam.getCsamReportsStats` — aggregate stats
- **Schema**: `src/server/schema/csam.schema.ts`
  - `createCsamReportSchema` — report creation
- **Job**: `src/server/jobs/send-csam-reports.ts` — hourly batch send to NCMEC
- **Data model columns**: userId, reportedById, createdAt, reportSentAt, archivedAt, contentRemovedAt

---

## Implementation Plan

### Phase 1: Core system

1. Add `ApprovalRequest` model to Prisma schema
2. Create `approvalRequest` tRPC router with `create`, `getAll`, `decide`, `getStatus`
3. Build moderator queue page at `/moderator/approval-requests`
4. Add `moderation/submit-approval-request` skill to the agent skills project

### Phase 2: Agent integration

5. Wire bounds checks in moderation skills to submit approval requests when out of bounds
6. Implement agent session pause/resume on approval request submission
7. Add pending count badge to moderator nav

### Phase 3: Polish

8. Bulk approve/reject
9. Auto-expire old requests (24h?)
10. Notification system (push notifications to mods when high-priority requests arrive)
11. Audit log for all approval decisions

---

## Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Where should the ApprovalRequest table live? | Main Civitai Postgres seems right, since it ties into the User model and moderator flow |
| 2 | Agent session pause/resume mechanism | Depends on the agent runner architecture — webhook, polling, or suspension? |
| 3 | Should expired requests auto-escalate? | If a request sits for 24h+ without a decision, should it ping a lead mod? |
| 4 | Should approved actions execute immediately or on next agent tick? | Immediate execution (server-side) is simpler and more reliable |

# Moderation Agents — Product Requirements Document

## 1. Overview & Goals

Civitai needs an automated moderation system where AI agents autonomously review content and users, take moderation actions within defined bounds, and escalate to human moderators when actions fall outside those bounds.

### Goals

1. **Reduce moderator workload** — agents handle routine moderation (clear-cut violations, standard reviews) so humans focus on nuanced cases
2. **Faster response times** — automated processing of reports, flagged content, and training data review
3. **Consistent enforcement** — agents follow defined rules and thresholds, reducing subjective variance
4. **Safety-first design** — agents cannot take high-impact actions without human approval; NCMEC reports always require human sign-off

### Non-Goals

- Replacing human moderators entirely
- Building the agent runner inside this repo (it lives externally)
- Handling appeals (separate system)

### Working Documents

This PRD consolidates and supersedes the working docs. They remain as references:

- [skills.md](skills.md) — detailed skill specifications with inline `@dev:` / `@ai:` / `@justin:` discussion
- [bounds.md](bounds.md) — bounds framework (template with proposed defaults filled in here)
- [approval-requests.md](approval-requests.md) — approval request system design with codebase references

---

## 2. System Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Runner (external repo)             │
│                                                                 │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────────────┐  │
│  │ Flagged User │   │ Report      │   │ Model / Bounty /     │  │
│  │ Agent        │   │ Triage Agent│   │ Article / Dataset    │  │
│  │              │   │             │   │ Review Agents        │  │
│  └──────┬───────┘   └──────┬──────┘   └──────────┬───────────┘  │
│         │                  │                     │              │
│         └──────────┬───────┴─────────────────────┘              │
│                    │                                            │
│         ┌──────────▼──────────┐                                 │
│         │  Skills (tool-use)  │                                 │
│         │  review/*           │                                 │
│         │  orchestrator/*     │                                 │
│         │  moderation/*       │                                 │
│         │  processing/*       │                                 │
│         └──────────┬──────────┘                                 │
│                    │                                            │
│         ┌──────────▼──────────┐                                 │
│         │  Shared Libraries   │                                 │
│         │  civitai-api.ts     │───── tRPC (Bearer token) ──────►│ Civitai API
│         │  civitai-db.ts      │───── Postgres (read-only) ─────►│ Civitai DB
│         │  clickhouse.ts      │───── ClickHouse ───────────────►│ Analytics
│         │  orchestrator.ts    │───── @civitai/client ──────────►│ Orchestrator
│         │  retool-db.ts       │───── Postgres ─────────────────►│ Retool DB
│         └─────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Where Things Live

| Component | Location | Notes |
|-----------|----------|-------|
| Agent runner | External repo | Hosts agent definitions, skills, shared libs |
| Skills | External repo | Standalone scripts: `execute(input) => output` |
| Shared libraries | External repo | `civitai-api.ts`, `civitai-db.ts`, `clickhouse.ts`, `orchestrator.ts` (wraps `@civitai/client`), `retool-db.ts` |
| API endpoints | **This repo** | tRPC routers called by skills via `civitai-api.ts` |
| ApprovalRequest system | **This repo** | New Prisma model, router, moderator UI |
| Strike system | **This repo** | Already implemented — `UserStrike` model, `strike.*` router, escalation engine |
| Moderator UI pages | **This repo** | Existing pages + new `/moderator/approval-requests` |

### Auth Model

- **tRPC calls**: `Authorization: Bearer ${CIVITAI_API_KEY}` — key belongs to a moderator-role service account. All moderation endpoints use `moderatorProcedure` (role check).
- **Orchestrator calls**: Handled by `@civitai/client` — auto-generated OpenAI-compatible client with typed functions for all orchestrator operations. Auth configured once via `createCivitaiClient({ auth })`.
- **Bot DMs**: `Authorization: Bearer ${BOT_API_KEY}` — key belongs to a dedicated bot user account for chat messages.
- **Direct DB reads**: Standard Postgres connection strings for Civitai DB (read-only) and Retool DB.

### Shared Libraries

```
lib/
  civitai-api.ts    # tRPC client — POST ${API_URL}/api/trpc/${procedure}
  civitai-db.ts     # Civitai Postgres (read-only for review skills)
  clickhouse.ts     # ClickHouse client for analytics queries
  orchestrator.ts   # Thin wrapper around @civitai/client (see below)
  retool-db.ts      # Retool Postgres client (UserNotes table)
  types.ts          # Shared input/output types
```

**Reference implementation**: `.claude/skills/mod-actions/query.mjs` shows the tRPC call pattern.

#### `orchestrator.ts` — Using `@civitai/client`

Instead of making raw HTTP calls to the orchestrator, all orchestrator skills use [`@civitai/client`](https://github.com/civitai/civitai-client-javascript) (`@civitai/client` on npm, currently `v0.2.0-beta`). This is an auto-generated TypeScript client from the orchestrator's OpenAPI spec that provides:

- **Typed recipe functions** for every orchestrator operation (mediaRating, chatCompletion, textToImage, transcription, etc.)
- **Auth handled once** — `createCivitaiClient({ auth })` configures Bearer token globally
- **Dev/prod routing** — `env: 'dev' | 'prod'` selects the correct base URL automatically
- **Type-safe inputs/outputs** — all request and response shapes are generated from the API spec
- **Stays in sync** — `npm run generate` regenerates from the latest swagger spec when the orchestrator API changes

```typescript
// lib/orchestrator.ts
import { createCivitaiClient } from '@civitai/client';

export const orchestrator = createCivitaiClient({
  auth: process.env.ORCHESTRATOR_ACCESS_TOKEN!,
  env: process.env.ORCHESTRATOR_ENV === 'production' ? 'prod' : 'dev',
});
```

Skills then import the client and call typed functions directly:

```typescript
// Example: orchestrator/scan-image skill
import { orchestrator } from '../lib/orchestrator';
import { invokeMediaRatingStepTemplate } from '@civitai/client';

const { data } = await invokeMediaRatingStepTemplate({
  client: orchestrator,
  body: {
    mediaUrl: input.imageUrl,
    engine: 'civitai',
    includeAgeClassification: true,
    includeFaceRecognition: true,
    includeAIRecognition: true,
    includeRealisticRecognition: true,
  },
});
// data is typed as MediaRatingOutput
```

---

## 3. Agent Definitions

Each agent is an LLM with a system prompt, a trigger, and access to all skills as tools. Agents pull data as needed — no pre-defined pipelines.

### 3.1 Flagged User Agent

**Trigger**: User accumulates strikes, gets reported multiple times, or is flagged by another agent.

**Inputs**: `{ userId: number }`

**Review process**: The agent investigates the user holistically:
1. Pull strike history (`review/strike-history`)
2. Check post history, generation history, training history as needed
3. Review reports against the user and their reporting behavior
4. Check membership/subscription status (affects bounds)
5. Review DMs if harassment is suspected

**Available actions**: `give-strike`, `mute-user`, `confirm-mute`, `ban-user`, `add-moderation-note`, `send-dm`, `report-ncmec`

---

### 3.2 Report Triage Agent

**Trigger**: New report submitted (or batch of reports in the queue).

**Inputs**: `{ reportId: number }` or `{ reportIds: number[] }`

**Review process**:
1. Read report details (reason, entity type, reporter info)
2. Check reporter credibility (`review/reports-by-history` — action rate)
3. Quick-scan the reported content (image scan, VLM description)
4. Classify urgency: CSAM (immediate), clear violation (fast-track), ambiguous (route to specialized agent)

**Available actions**: `action-report` (action or dismiss), route to specialized agent (Model Review, Article Review, etc.)

---

### 3.3 Report Processing Agent

**Trigger**: Routed from Report Triage for reports requiring deeper investigation.

**Inputs**: `{ reportId: number, triageNotes?: string }`

**Review process**:
1. Full content analysis (VLM description, scan results)
2. User history investigation (prior violations, account age, activity patterns)
3. Cross-reference with similar reports or patterns
4. Determine appropriate action and severity

**Available actions**: `action-report`, `give-strike`, `block-content`, `mute-user`, `ban-user`, `report-ncmec`, `add-moderation-note`, `add-note-to-report`

---

### 3.4 Model Review Agent

**Trigger**: New model published, model reported, or periodic review queue.

**Inputs**: `{ modelId: number }` or `{ modelVersionId: number }`

**Review process**:
1. Check model metadata (name, description, tags, type)
2. Generate test images using the model (`orchestrator/generate-image`)
3. Scan generated images (`orchestrator/scan-image`)
4. Describe generated images with VLM (`orchestrator/describe-image`)
5. Check creator's history and standing

**Available actions**: `block-content` (model/version), `give-strike`, `action-report`, `add-moderation-note`

---

### 3.5 Bounty Review Agent

**Trigger**: New bounty created, bounty reported.

**Inputs**: `{ bountyId: number }`

**Review process**:
1. Review bounty description and attached images
2. Scan images for violations
3. Check creator's history

**Available actions**: `block-content` (bounty), `give-strike`, `action-report`, `add-moderation-note`

---

### 3.6 Article Review Agent

**Trigger**: New article published, article reported.

**Inputs**: `{ articleId: number }`

**Review process**:
1. Review article text content
2. Scan embedded images
3. Check for prohibited content patterns
4. Check author's history

**Available actions**: `block-content` (article), `give-strike`, `action-report`, `add-moderation-note`

---

### 3.7 Dataset Review Agent

**Trigger**: Training data flagged by automated scan, training data reported.

**Inputs**: `{ modelVersionId: number }`

**Review process**:
1. Pull training overview (`review/training-history` sub-command A)
2. Pull captions from training data ZIP (`review/training-history` sub-command B)
3. Scan suspicious captions by fetching specific images (`review/training-history` sub-command C)
4. Run image scans on flagged images (`orchestrator/scan-image`)
5. Check if scan results show minors, prohibited content

**Available actions**: `approve-training`, `block-content` (training), `give-strike`, `report-ncmec`, `request-identity-docs`, `add-moderation-note`

---

## 4. Skills Catalog

Skills are standalone scripts with `execute(input) => output`. They share no state. Full specifications with implementation details are in [skills.md](skills.md).

### 4.1 Review Skills (12) — Read-Only

| Skill | Input | Output Summary | Data Source |
|-------|-------|----------------|-------------|
| `review/post-history` | `{ userId, limit?, since? }` | Posts, images, models, articles, bounties | Civitai DB (Prisma) |
| `review/strike-history` | `{ userId }` | Strike records, total points, escalation state | **tRPC `strike.getUserHistory`** |
| `review/generation-history` | `{ userId, limit?, since? }` | Generation jobs with prompts, params | ClickHouse `orchestration.jobs` |
| `review/training-history` | A: `{ userId }`, B: `{ modelVersionId, limit? }`, C: `{ modelVersionId, filename }` | A: training runs, B: captions from ZIP, C: specific image | Civitai DB + S3 |
| `review/buzz-purchase-history` | `{ userId, limit?, since? }` | Purchase transactions | ClickHouse `default.buzzTransactions` |
| `review/buzz-spending-history` | `{ userId, since? }` | Spending summary by category/month | ClickHouse `default.buzzTransactions` |
| `review/report-against-history` | `{ userId, limit?, since? }` | Reports filed against user's content, with entity details | Civitai DB `Report` |
| `review/deleted-images-history` | `{ userId, limit?, since? }` | TOS-deleted images | ClickHouse `images` (type='DeleteTOS') |
| `review/reports-by-history` | `{ userId, limit? }` | Reports user has filed + credibility stats | Civitai DB `Report` |
| `review/dms` | `{ userId, limit? }` | Chat messages | Civitai DB `ChatMessage` |
| `review/membership-status` | `{ userId }` | Subscriptions with product details | Civitai DB `CustomerSubscription` |
| `review/user-metrics` | `{ userId }` | Metrics, stats, account flags | Civitai DB `UserMetric` + `UserStat` + `User` |

#### Strike History — Now Implemented

The `review/strike-history` skill maps to the implemented `strike.getUserHistory` tRPC endpoint:

```typescript
// tRPC call
POST /api/trpc/strike.getUserHistory
Body: { json: { userId: number } }

// Returns
{
  strikes: UserStrike[],      // Full history (active + expired + voided)
  totalActivePoints: number,  // Sum of active, non-expired strike points
  nextExpiry: Date | null,    // When the next strike expires
  user: {                     // User profile snapshot
    id, username, createdAt, muted, bannedAt, deletedAt, meta
  }
}
```

Each `UserStrike` record includes: `id`, `reason` (StrikeReason enum), `status` (Active/Expired/Voided), `points` (1-3), `description`, `internalNotes`, `entityType`, `entityId`, `reportId`, `createdAt`, `expiresAt`, `issuedBy`, and void fields if applicable.

**StrikeReason values**: `BlockedContent`, `RealisticMinorContent`, `CSAMContent`, `TOSViolation`, `HarassmentContent`, `ProhibitedContent`, `ManualModAction`.

---

### 4.2 Orchestrator Skills (5) — External Services

All orchestrator skills use `@civitai/client` for type-safe API calls. Each skill imports the shared `orchestrator` client instance from `lib/orchestrator.ts` and calls the appropriate typed function.

| Skill | `@civitai/client` Function | Input Type | Output Type |
|-------|---------------------------|------------|-------------|
| `orchestrator/describe-image` | `invokeChatCompletionStepTemplate` | `ChatCompletionInput` | `ChatCompletionOutput` |
| `orchestrator/generate-image` | `invokeTextToImageStepTemplate` | `TextToImageInput` | `TextToImageOutput` |
| `orchestrator/scan-image` | `invokeMediaRatingStepTemplate` | `MediaRatingInput` | `MediaRatingOutput` |
| `orchestrator/blur-image` | `invokeConvertImageStepTemplate` | `ConvertImageInput` (with `BlurTransform`) | `ConvertImageOutput` |
| `orchestrator/generate-transcript` | `invokeTranscriptionStepTemplate` | `TranscriptionInput` | `TranscriptionOutput` |

#### Skill-to-client mapping details

**`orchestrator/describe-image`** — VLM image description via chat completions:
```typescript
import { invokeChatCompletionStepTemplate } from '@civitai/client';

const { data } = await invokeChatCompletionStepTemplate({
  client: orchestrator,
  body: {
    model: '<custom-model-name>', // @dev:* What VLM model name to use?
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: input.prompt ?? 'Describe this image in detail.' },
        { type: 'image_url', image_url: { url: input.imageUrl } },
      ],
    }],
    maxTokens: input.maxTokens ?? 200,
  },
});
```

**`orchestrator/scan-image`** — content classification via media rating:
```typescript
import { invokeMediaRatingStepTemplate } from '@civitai/client';

const { data } = await invokeMediaRatingStepTemplate({
  client: orchestrator,
  body: {
    mediaUrl: input.imageUrl,
    engine: 'civitai',
    includeAgeClassification: true,
    includeFaceRecognition: true,
    includeAIRecognition: true,
    includeRealisticRecognition: true,
  },
});
// data: MediaRatingOutput { nsfwLevel, isBlocked, blockedReason, labels,
//   ageClassification, faceRecognition, aiRecognition, animeRecognition }
```

**`orchestrator/generate-image`** — test image generation:
```typescript
import { invokeTextToImageStepTemplate } from '@civitai/client';

// Skill handles LoRA detection internally:
// 1. Query DB to check if modelVersionId is a LoRA
// 2. If LoRA, resolve base model from ModelVersion.baseModel
// 3. Build request with both resources
const { data } = await invokeTextToImageStepTemplate({
  client: orchestrator,
  body: { /* TextToImageInput with model resources, prompts, params */ },
});
```

**`orchestrator/blur-image`** — blur regions via image conversion with `BlurTransform`:
```typescript
import { invokeConvertImageStepTemplate } from '@civitai/client';

const { data } = await invokeConvertImageStepTemplate({
  client: orchestrator,
  body: {
    image: input.imageUrl,
    transforms: [{
      type: 'blur',
      blur: input.blur,        // 1-100 intensity
      mode: input.mode,        // 'include' | 'exclude'
      regions: input.regions,  // { x1, y1, x2, y2 }[]
    }],
    output: { type: 'jpeg' },
  },
});
// data: ConvertImageOutput { blob: ImageBlob }
```

**Note**: Blur is not a standalone recipe — it's a `BlurTransform` applied through the `convertImage` recipe. The `@civitai/client` types (`BlurTransform`, `BlurRegion`, `BlurRegionMode`) provide full type safety for the blur parameters.

**`orchestrator/generate-transcript`** — video/audio transcription:
```typescript
import { invokeTranscriptionStepTemplate } from '@civitai/client';

const { data } = await invokeTranscriptionStepTemplate({
  client: orchestrator,
  body: { mediaUrl: input.mediaUrl },
});
// data: TranscriptionOutput { text, segments: { start, end, text }[] }
```

---

### 4.3 Moderation Skills (9) — State-Changing

Each skill attempts the action directly. If the action falls outside auto-action bounds, it returns `{ requiresApproval: true, action, reason }` and the agent submits an approval request.

#### moderation/give-strike

Issue a strike against a user. **Now maps to `strike.create` tRPC endpoint.**

```typescript
// Skill input
{ userId: number, reason: StrikeReason, points: 1 | 2 | 3, description: string,
  internalNotes?: string, entityType?: EntityType, entityId?: number,
  reportId?: number, expiresInDays?: number /* default 30 */ }

// tRPC call
POST /api/trpc/strike.create
Body: { json: <input> }

// Skill output
{ strikeId: number, totalActivePoints: number, escalationAction: EscalationAction }
// where EscalationAction = 'none' | 'muted' | 'muted-and-flagged' | 'unmuted'
```

**Key behaviors**:
- **Rate limiting**: Non-`ManualModAction` strikes are limited to 1 per user per day (enforced by `shouldRateLimitStrike()`)
- **Escalation is automatic**: After creating a strike, `evaluateStrikeEscalation()` runs and may mute the user (see Section 5)
- **Notifications**: User receives in-app notification + email on strike issuance
- **Bounds check**: Skill checks bounds before calling the endpoint. If out of bounds → `{ requiresApproval: true }`

#### moderation/ban-user

```typescript
// Skill input
{ userId: number, reasonCode: BanReasonCode, detailsExternal?: string, detailsInternal?: string }

// tRPC call: user.toggleBan
// BanReasonCodes: SexualMinor, SexualMinorGenerator, SexualMinorTraining, SexualPOI,
//   Bestiality, Scat, Nudify, Harassment, LeaderboardCheating, BuzzCheating, RRDViolation, Other
```

**Reference**: `src/server/services/user.service.ts` — `toggleBan()` handles all side effects (session invalidation, content unpublishing, subscription cancellation).

#### moderation/report-ncmec

**Always requires human approval. No exceptions.**

```typescript
// Skill input (agent provides minimal info — skill handles orchestration internally)
{ imageUrl: string, userId: number, entityType?: string, entityId?: number, sourceFilename?: string }

// Skill output
{ approvalRequestId: number }
```

Internal flow (all orchestrator calls via `@civitai/client`):
1. `scan-image` (`invokeMediaRatingStepTemplate`) → get face bounding boxes
2. `blur-image` (`invokeConvertImageStepTemplate` with `BlurTransform`) → create safe preview
3. `describe-image` (`invokeChatCompletionStepTemplate`) → generate text description
4. Submit approval request with safe materials only
5. On human approval → feed into existing `send-csam-reports` job pipeline

#### moderation/block-content

```typescript
// Skill input
{ entityType: 'model' | 'modelVersion' | 'article' | 'bounty' | 'image' | 'training',
  entityId: number, reason: string }
```

**Existing endpoints by entity type**:
- **Image**: `image.setTosViolation` or `POST /api/mod/remove-images`
- **Model**: `model.unpublish` — `{ id, reason?, customMessage? }`
- **Article**: `article.unpublish` — `{ id, reason?, customMessage? }`
- **Bounty**: **New endpoint needed** — refund deposited buzz to creator + delete bounty (no schema changes)
- **Training**: Use `approve-training` with `action: 'deny'` instead

#### moderation/approve-training

```typescript
// Skill input
{ modelVersionId: number, action: 'approve' | 'deny' }

// tRPC calls
// approve: mod.trainingData.approve — { id: modelVersionId }
// deny: mod.trainingData.deny — { id: modelVersionId }
// Handlers: handleApproveTrainingData, handleDenyTrainingData
```

**Reference**: `src/server/controllers/training.controller.ts`

#### moderation/mute-user

```typescript
// Skill input
{ userId: number }

// tRPC call: user.toggleMute — { id: userId }
```

#### moderation/confirm-mute

```typescript
// Skill input
{ userId: number }

// Implementation: look up UserRestriction record, then call
// tRPC userRestriction.resolve — { userRestrictionId, status: 'Upheld' }
// Handles subscription cancellation and session refresh
```

**Reference**: `src/server/routers/user-restriction.router.ts`

#### moderation/action-report

```typescript
// Skill input
{ reportId: number, status: 'Actioned' | 'Unactioned' }

// tRPC call: report.setStatus — { id: reportId, status }
// Actioned = confirmed violation (triggers reporter rewards via reportAcceptedReward.apply())
// Unactioned = dismissed (no rewards)
```

**Note**: `Unactioned` serves as dismissal — no separate dismiss skill needed.

#### moderation/add-note-to-report

Add an internal note to an existing report.

```typescript
// Skill input
{ reportId: number, note: string }

// Implementation: fetch report's current status, then call
// tRPC report.update — { id: reportId, status: <current>, internalNotes: note }
// The internalNotes field already exists on the Report model (String?, nullable)
```

**Reference**: `src/server/routers/report.router.ts` — `report.update` with `updateReportSchema`

---

### 4.4 Processing Skills (3) — Communications & Notes

#### processing/request-identity-docs

```typescript
// Skill input
{ userId: number, reason: string, entityType?: string, entityId?: number }

// Sends form email via nodemailer + SES SMTP
// Subject includes tag: [ID-VERIFY-{userId}-{sessionId}]
// Phase 1: humans monitor inbox manually
// Phase 2 (future): inbox monitor matches replies to agent sessions
```

#### processing/add-moderation-note

```typescript
// Skill input
{ userId: number, note: string, setSpamWhitelist?: boolean, setDeservedMute?: boolean }

// Writes to Retool Postgres → UserNotes table
// INSERT INTO "UserNotes" ("userId", notes, "lastUpdateBy", "spamWhitelist", "deservedMute")
// VALUES ($1, $2, 'mod-agent', $3, $4)
```

**UserNotes schema** (Retool DB): `id` (auto-increment), `userId`, `notes` (text), `lastUpdate` (timestamp), `lastUpdateBy` (text), `spamWhitelist` (boolean), `deservedMute` (boolean). Multiple rows per user.

#### processing/send-dm

```typescript
// Skill input
{ userId: number, message: string }

// Uses BOT_API_KEY (bot user's token) to call chat tRPC endpoints
// Creates or finds chat → sends ChatMessage with contentType: 'Markdown'
```

---

## 5. Bounds & Escalation Rules

Bounds define when an agent can auto-act vs. when it must request human approval. Each moderation skill checks bounds before executing. If out of bounds, the skill returns `{ requiresApproval: true }` and the agent submits an approval request.

> **Note**: All threshold values below are **proposed defaults** — starting points for review. They should be validated before implementation and tuned based on observed agent accuracy.

### 5.1 User-Level Bounds

#### Mute User

**Auto-mute when ALL of**:
- User has 3+ active strikes
- Account is < 7 days old with a TOS violation

**Always escalate mute when ANY of**:
- User has an active paid subscription
- User is a creator program member
- Account is > 1 year old

@dev: Are these thresholds reasonable starting points? Should account age threshold be higher/lower?

#### Confirm Mute

**Auto-confirm when**:
- Mute was auto-applied by strike escalation (not manual)
- User has no active paid subscription

**Always escalate when**:
- User has an active paid subscription (cancellation impact)
- User is in the creator program

#### Ban User

**Auto-ban when**:
- CSAM detection with confidence > 95% (scan `isMinor` + `isRealistic` both high)
- User has 5+ confirmed strikes (active, not voided)

**Always escalate ban when**:
- All bans (initially) — loosen as trust builds

@dev: Starting with "always escalate all bans" is conservative. Once we see agent accuracy on mutes, we can open auto-ban for clear-cut cases.

#### Give Strike

**Auto-strike when ALL of**:
- Clear TOS violation confirmed by scan + VLM (confidence > 90%)
- Points: 1-3 based on severity (agent determines)
- Rate-limited: max 1 auto-strike per user per day (`ManualModAction` reason bypasses this)

**Always escalate when**:
- Agent wants to issue 3-point strike (max severity)
- User is a creator program member
- User has an active paid subscription

### 5.2 Strike Escalation Integration

The strike system has a built-in escalation engine (`evaluateStrikeEscalation()` in `strike.service.ts`). This runs automatically after every `strike.create` call:

| Total Active Points | Action | Details |
|---------------------|--------|---------|
| < 2 | None | If previously strike-muted, **unmute** and clear flag |
| 2 | Timed mute | 3-day mute (timer resets/extends on each new strike) |
| 3+ | Indefinite mute + flag | Muted indefinitely, `meta.strikeFlaggedForReview = true` |

**Key behaviors**:
- Escalation is automatic — agents don't need to separately call mute
- De-escalation also automatic — voiding a strike re-evaluates and may unmute
- No auto-ban from strikes — indefinite mute + flagged for human review is the ceiling
- Background jobs handle maintenance:
  - `expire-strikes` (daily at 2 AM): expires old strikes, re-evaluates escalation
  - `process-timed-unmutes` (hourly): unmutes users whose 3-day mute expired, re-evaluates

**Notifications sent to users**: strike-issued, strike-voided, strike-escalation-muted, strike-expired, strike-de-escalation-unmuted.

---

### 5.3 Content-Level Bounds

#### Block Image

**Auto-block when ANY of**:
- Matches a blocked perceptual hash (distance < 5)
- Scan returns `isBlocked = true`

**Always escalate when ANY of**:
- Image is from a user with an active paid subscription
- Image has 50+ reactions

#### Block Model

**Auto-block when**:
- Test generations all return prohibited content (3/3 samples blocked by scan)

**Always escalate when ANY of**:
- Model has 1,000+ downloads
- Creator is a creator program member

#### Block Model Version

Same rules as Block Model, applied at the version level.

#### Block Article

**Auto-block when**:
- Scan flags content with high confidence (> 90%)
- Embedded images all blocked

**Always escalate when**:
- Author has an active paid subscription
- Article has significant engagement (50+ likes)

#### Block Bounty

**Auto-block when**:
- Scan flags content with high confidence (> 90%)

**Always escalate when**:
- Bounty has been funded (buzz deposited)
- Creator has an active paid subscription

@dev: Bounty blocking needs a new endpoint. Options: (1) soft-delete status on Bounty, (2) refund buzz + delete. Which approach?
@manuel: let's go with option 2 refund buzz + delete since it requires less changes in db schema and queries all around the project
@ai: Acknowledged. Bounty blocking will use refund buzz + delete. No schema changes needed — the endpoint will refund any deposited buzz to the creator's account, then delete the bounty. Updated PRD sections 4.3, 7.2, and open questions accordingly.

#### Block Training / Deny Training

**Auto-block when**:
- Dataset scan detects minors with high confidence (> 90% on `isMinor`)
- Same-person face detection + no AI metadata on images

**Always escalate when**:
- Training run has already completed (model may be in use)
- Creator is a creator program member

---

### 5.4 Report-Level Bounds

#### Action Report

**Auto-action when ALL of**:
- Reporter has > 80% action rate (credibility signal from `review/reports-by-history`)
- Content scan clearly matches the reported violation type

**Always escalate when**:
- Reported content belongs to a creator program member
- Report reason is `CSAM` (route to NCMEC flow)

#### Dismiss Report

**Auto-dismiss when ALL of**:
- Reporter has < 20% action rate
- Content scan shows no violation

**Always escalate when**:
- Reporter has > 80% action rate (credible reporter flagging something scans missed)

---

### 5.5 NCMEC Report

**Always requires human approval. No auto-action under any circumstance.**

The agent prepares the report with safe materials only:
- Blurred images (bounding boxes from face detection)
- VLM text description of content
- Link to entity in moderator UI for optional review

Human approves the prepared report → feeds into the existing `send-csam-reports` hourly batch job.

---

### 5.6 General Principles

1. **All auto-actions are logged and reviewable** — every action (auto or approved) is tracked via `logToAxiom()` with structured event data
2. **Conservative start** — begin with tight bounds, loosen based on observed accuracy
3. **Paying users get extra scrutiny** — actions against subscribers and creator program members always escalate
4. **Confidence thresholds are minimums** — agents should still exercise judgment and escalate when uncertain, even if technically within bounds
5. **Rate limiting on auto-strikes** — max 1 auto-strike per user per day prevents runaway enforcement (manual mod actions bypass this)
6. **No auto-ban from strike escalation** — the escalation engine tops out at "indefinite mute + flagged for review"; bans require explicit action

---

## 6. Approval Request System

When an agent determines that a moderation action is needed but falls outside auto-action bounds, it submits an **approval request** for human review.

### 6.1 Data Schema

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
  evidence        Json?     // Structured evidence (scan results, user history, etc.)

  // Safe materials for review
  safePreviewUrl  String?   // Blurred/safe version of content
  reviewUrl       String?   // Link to entity in moderator UI

  // Agent session tracking
  agentSessionId  String    // To resume the agent on decision
  agentType       String    // Which agent submitted this

  // Decision
  status          ApprovalRequestStatus @default(Pending)
  decidedAt       DateTime?
  decidedBy       Int?
  decidedByUser   User?     @relation(fields: [decidedBy], references: [id])
  rejectionReason String?

  // Proposed action params
  actionParams    Json      // Exact params to pass to the skill on approval
}

enum ApprovalRequestStatus {
  Pending
  Approved
  Rejected
  Expired     // Auto-expired after timeout (e.g., 24h)
  Cancelled   // Agent cancelled the request
}
```

**Key design decisions**:
- `actionParams` stores the exact skill input → action executes identically to what was proposed
- `reasoning` contains the agent's chain-of-thought → moderator understands *why* without re-investigating
- `safePreviewUrl` → for NCMEC cases, moderator never sees raw content
- `agentSessionId` → links back to agent session for resume/notification

### 6.2 API Endpoints

All endpoints use `moderatorProcedure` except `create` and `getStatus` which use the agent's Bearer token.

#### `approvalRequest.create` (agent-facing)

```typescript
input: {
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
output: { id: number, status: 'Pending' }
```

#### `approvalRequest.getAll` (moderator-facing)

```typescript
input: {
  status?: ApprovalRequestStatus;
  agentType?: string;
  action?: string;
  page?: number;
  limit?: number;
}
output: { items: ApprovalRequest[], totalCount: number }
```

#### `approvalRequest.decide` (moderator-facing)

```typescript
input: {
  id: number;
  decision: 'Approved' | 'Rejected';
  rejectionReason?: string; // Required if Rejected
}
```

**Side effects on Approved**:
1. Update status, `decidedAt`, `decidedBy`
2. Execute the action using stored `actionParams`
3. Notify agent session (webhook or polling)

**Side effects on Rejected**:
1. Update status, set `rejectionReason`
2. Notify agent session with rejection reason

#### `approvalRequest.getStatus` (agent-facing, for polling)

```typescript
input: { id: number }
output: { status: ApprovalRequestStatus, decidedAt?: Date, rejectionReason?: string }
```

@dev: How should the agent "pause"? Options: (1) webhook callback when decision is made, (2) agent polls `getStatus`, (3) agent session is suspended and resumed on decision. Which fits best with the agent runner architecture?

### 6.3 Moderator UI

**Page**: `/moderator/approval-requests`

**UI pattern**: Two-panel split layout (like `/moderator/generation-restrictions`):
- Left panel (500px fixed): scrollable list of requests
- Right panel (flex-1): detail view for selected request

**Codebase references for implementation**:
- `src/pages/moderator/generation-restrictions.tsx` — closest analog (two-panel decision queue)
- `src/store/select.store.ts` — `createSelectStore` for selection state
- `src/server/routers/user-restriction.router.ts` — router pattern with `moderatorProcedure`
- `src/server/logging/client.ts` — `logToAxiom()` for audit logging

**Layout**:
```
┌──────────────────────────────────────────────────────────────────────┐
│ Approval Requests                              [Pending: 12] [All]  │
├──────────────────────┬───────────────────────────────────────────────┤
│ Filter:              │                                              │
│ [Status▼] [Agent▼]  │  Action: ban-user                            │
│ [Action▼]           │  Target: User #12345 (username)  [View →]    │
│                      │  Agent: image-review    Session: abc-123     │
│ ● ban-user  | 5m    │  Submitted: 2025-01-15 14:30                 │
│   User #12345        │                                              │
│   image-review agent │  Agent's Reasoning:                          │
│                      │  User uploaded 3 training datasets...        │
│ ○ block-model | 12m  │                                              │
│   Model #678         │  Evidence:                                   │
│   model-review agent │  • Scan: 7/50 flagged (isMinor > 0.8)       │
│                      │  • Account age: 2 days                       │
│ ○ report-ncmec | 1h  │                                              │
│   User #91011        │  Safe Preview: [blurred image]               │
│   dataset-review     │                                              │
│                      │  Action Params:                               │
│                      │  { userId: 12345, reasonCode: "..." }        │
│                      │                                              │
│                      │           [Approve]  [Reject with reason...] │
└──────────────────────┴───────────────────────────────────────────────┘
```

**Key UX**:
- Pending count badge in moderator nav (see Section 7)
- NCMEC requests highlighted with distinct badge/color
- Bulk approve for low-risk actions
- Rejection requires a reason (feeds back to agent)
- Audit logging via `logToAxiom()` for all decisions

### 6.4 Agent Session Pause/Resume

When a skill returns `{ requiresApproval: true }`:
1. Agent calls `approvalRequest.create` with full context
2. Agent session pauses (mechanism TBD — see open question above)
3. Moderator reviews and decides
4. On decision, agent session is notified/resumed
5. If approved: agent proceeds with the action
6. If rejected: agent receives rejection reason and adjusts approach

---

## 7. Implementation in This Repo

### 7.1 New: ApprovalRequest Model + Router + UI

| Component | File Path | Notes |
|-----------|-----------|-------|
| Prisma model | `prisma/schema.full.prisma` | Add `ApprovalRequest` model + `ApprovalRequestStatus` enum |
| Schema | `src/server/schema/approval-request.schema.ts` | Zod schemas for create, getAll, decide, getStatus |
| Router | `src/server/routers/approval-request.router.ts` | tRPC router with `moderatorProcedure` |
| Controller | `src/server/controllers/approval-request.controller.ts` | Handler functions |
| Service | `src/server/services/approval-request.service.ts` | Business logic, side effects on decision |
| UI page | `src/pages/moderator/approval-requests.tsx` | Two-panel layout |

### 7.2 New: Bounty Blocking Endpoint

No endpoint currently exists for blocking/removing bounties from a moderator context. **Decision: refund buzz + delete** — the new `moderatorProcedure` endpoint will:

1. Refund any deposited buzz back to the creator's account
2. Delete the bounty record
3. No schema changes required — avoids adding a soft-delete status that would need handling across all bounty queries

### 7.3 New: Feature Flag + Nav Entry

Add feature flag for approval requests and add nav entry to `ModerationNav`:

```typescript
// In src/components/Moderation/ModerationNav.tsx, add:
{
  label: 'Approval Requests',
  href: '/moderator/approval-requests',
  hidden: !features.moderationAgents,
}
```

Feature flag: `moderationAgents` in Flipt, initially restricted to dev/granted.

### 7.4 Existing Endpoints Called by Agents

These already exist and work. The agent skills call them via tRPC:

| Endpoint | Router | Purpose |
|----------|--------|---------|
| `strike.create` | `src/server/routers/strike.router.ts` | Issue strikes (with auto-escalation) |
| `strike.getUserHistory` | `src/server/routers/strike.router.ts` | Pull user strike history |
| `strike.getUserStandings` | `src/server/routers/strike.router.ts` | Check user's strike standings |
| `user.toggleBan` | `src/server/routers/user.router.ts` | Ban/unban users |
| `user.toggleMute` | `src/server/routers/user.router.ts` | Mute/unmute users |
| `userRestriction.resolve` | `src/server/routers/user-restriction.router.ts` | Confirm/overturn mutes |
| `report.setStatus` | `src/server/routers/report.router.ts` | Action/dismiss reports |
| `report.update` | `src/server/routers/report.router.ts` | Add internal notes to reports |
| `model.unpublish` | `src/server/routers/model.router.ts` | Block models/versions |
| `article.unpublish` | `src/server/routers/article.router.ts` | Block articles |
| `image.setTosViolation` | `src/server/controllers/image.controller.ts` | Block images |
| `mod.trainingData.approve` | `src/server/routers/moderator/index.ts` | Approve training |
| `mod.trainingData.deny` | `src/server/routers/moderator/index.ts` | Deny training |

### 7.5 Existing: Strike System (Fully Implemented)

The strike system is complete and ready for agent integration:

| Component | File | Key Exports |
|-----------|------|-------------|
| Prisma model | `prisma/schema.full.prisma:5173` | `UserStrike`, `StrikeReason`, `StrikeStatus` |
| Router | `src/server/routers/strike.router.ts` | `strike.create`, `.void`, `.getUserHistory`, `.getAll`, `.getUserStandings`, `.getMyStrikes`, `.getMyStrikeSummary` |
| Service | `src/server/services/strike.service.ts` | `createStrike()`, `voidStrike()`, `evaluateStrikeEscalation()`, `expireStrikes()`, `processTimedUnmutes()`, `shouldRateLimitStrike()` |
| Schema | `src/server/schema/strike.schema.ts` | `createStrikeSchema`, `voidStrikeSchema`, `getStrikesSchema`, `getUserStandingsSchema` |
| Controller | `src/server/controllers/strike.controller.ts` | Handler functions |
| Jobs | `src/server/jobs/process-strikes.ts` | `expireStrikesJob` (daily 2 AM), `processTimedUnmutesJob` (hourly) |
| UI | `src/pages/moderator/strikes.tsx` | Moderator dashboard |
| Notifications | `src/server/notifications/strike.notifications.ts` | 5 notification types |
| Feature flag | Flipt | `strikes: ['dev', 'granted']` |

---

## 8. Implementation Phases

### Phase 1: Core Infrastructure (This Repo)

1. Add `ApprovalRequest` model to `prisma/schema.full.prisma`
2. Create `approvalRequest` tRPC router with `create`, `getAll`, `decide`, `getStatus`
3. Build moderator queue page at `/moderator/approval-requests`
4. Add `moderationAgents` feature flag
5. Add nav entry to `ModerationNav`
6. Build bounty blocking endpoint (refund buzz + delete)

### Phase 2: Agent Skills (External Repo)

7. Implement shared libraries (`civitai-api.ts`, `civitai-db.ts`, `clickhouse.ts`, `orchestrator.ts`, `retool-db.ts`)
8. Implement review skills (12 skills)
9. Implement orchestrator skills (5 skills)
10. Implement moderation skills (8 skills) with bounds checking
11. Implement processing skills (3 skills)
12. Define bounds configuration (values from Section 5)

### Phase 3: Agent Runner Integration

13. Build agent runner with system prompts for each of the 7 agents
14. Wire skills as tool-use definitions
15. Implement agent session pause/resume on approval request submission
16. Add pending count badge to moderator nav (real-time or polling)
17. Test end-to-end flows: report → triage → action/escalation → approval

### Phase 4: Polish

18. Bulk approve/reject in UI
19. Auto-expire old requests (24h timeout → status = Expired)
20. Notifications to mods when high-priority requests arrive (NCMEC, ban requests)
21. Audit log dashboard for all agent actions
22. Tune bounds based on observed agent accuracy
23. Expand auto-action bounds as confidence increases

---

## 9. Open Questions

| # | Question | Affects | Status |
|---|----------|---------|--------|
| 1 | Custom VLM model name for orchestrator chat completions endpoint | `orchestrator/describe-image` | **Open** — @dev to provide |
| 2 | Bounty blocking approach: soft-delete status or refund+delete? | `moderation/block-content`, Phase 1 endpoint | **Resolved** — refund buzz + delete (no schema changes) |
| 3 | Agent session pause/resume mechanism — webhook, polling, or suspension? | Approval request flow, Phase 3 | **Open** — depends on agent runner architecture |
| 4 | Should expired approval requests auto-escalate to a lead mod? | Approval request system | **Open** — product decision |
| 5 | Should approved actions execute server-side immediately or on next agent tick? | Approval request system | **Leaning immediate** — simpler, more reliable |
| 6 | Where should the ApprovalRequest table live? | Schema design | **Resolved** — main Civitai Postgres (ties into User model and moderator flow) |

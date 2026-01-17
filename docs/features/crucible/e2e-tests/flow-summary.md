# Crucible E2E Test Flows Summary

**Generated**: 2026-01-17
**Browser Server**: http://localhost:9222
**Flows Location**: `.browser/flows/e2e-*.js`

## Overview

This document summarizes the saved browser automation flows for end-to-end testing of Crucible features. These flows cover:

1. **Crucible Creation** - Creating a new crucible contest
2. **Entry Submission** - Users submitting images to compete
3. **Judging** - Users rating pairs of images
4. **Cancellation & Refunds** - Testing cancellation with automatic refunds

## Flow Inventory

### Primary Test Flows (Crucible #20)

| Flow Name | Profile Required | Parameters | Start URL |
|-----------|-----------------|------------|-----------|
| `e2e-create-crucible` | member | `Crucible Name` | `/crucibles/create` |
| `e2e-user1-submit` | member | none | `/crucibles/20` |
| `e2e-user2-submit` | testing-login (userId: 4) | none | `/crucibles/20` |
| `e2e-user3-submit` | testing-login (userId: 5) | none | `/crucibles/20` |
| `e2e-user1-judge` | member | none | `/crucibles/20/judge` |
| `e2e-user2-judge` | testing-login (userId: 4) | none | `/crucibles/20/judge` |

### Cancellation Test Flows (Crucible #21)

| Flow Name | Profile Required | Parameters | Start URL |
|-----------|-----------------|------------|-----------|
| `e2e-cancel-create` | member | `Crucible Name`, `Description` | `/crucibles/create` |
| `e2e-cancel-user1-submit` | member | none | `/crucibles/21` |
| `e2e-cancel-user2-submit` | testing-login (userId: 4) | none | `/crucibles/21` |
| `e2e-cancel-refund` | member (mod permissions) | none | `/crucibles/21` |

## Profile Requirements

### Available Profiles

| Profile | Description | Use Case |
|---------|-------------|----------|
| `member` | JustMaier (userId: 1) - Standard logged-in user with moderator permissions | Creating crucibles, submitting entries, judging |
| `testing-login` | Custom auth using `/api/auth/callback/testing-login` | Required for multi-user testing |

### Important: Crucible Feature Flag

In development mode, the Crucible feature requires moderator permissions:

```typescript
// src/server/services/feature-flags.service.ts
crucible: isDev ? ['mod', 'granted'] : []
```

This means:
- The `member` profile works because JustMaier has mod permissions
- For additional users, use `testing-login` with moderator user IDs:
  - User ID 4: `manuelurenah`
  - User ID 5: `bkdiehl482`
  - User ID 6: `koenb`

### Using testing-login in Flows

To authenticate as a different user in a flow:

```javascript
// Get CSRF token
const csrfRes = await page.context().request.get("http://localhost:3000/api/auth/csrf");
const { csrfToken } = await csrfRes.json();

// Login as specific user
await page.context().request.post("/api/auth/callback/testing-login", {
  form: {
    csrfToken,
    id: "4", // User ID
    callbackUrl: "http://localhost:3000/"
  }
});

// Navigate to trigger session reload
await page.goto("http://localhost:3000/");
```

## Flow Details

### 1. e2e-create-crucible

**Purpose**: Creates a new crucible contest

**Parameters**:
- `Crucible Name` (required): Name for the crucible (e.g., "E2E Test Crucible")

**Actions**:
1. Fills Basic Info step (name, description, cover image)
2. Sets Entry Rules (100 Buzz entry fee, 2 entries per user)
3. Skips Prize distribution (uses defaults: 50%/30%/20%)
4. Creates crucible and returns the URL

**Usage**:
```bash
curl -X POST http://localhost:9222/flows/e2e-create-crucible/run \
  -d '{
    "profile": "member",
    "params": { "Crucible Name": "My Test Crucible" }
  }'
```

---

### 2. e2e-user1-submit

**Purpose**: Submits 2 entries as User 1 (member)

**Actions**:
1. Records initial Buzz balance
2. Opens Submit Entry modal
3. Selects 2 images from gallery
4. Submits entries (200 Buzz total)
5. Records final Buzz balance

**Usage**:
```bash
curl -X POST http://localhost:9222/flows/e2e-user1-submit/run \
  -d '{"profile": "member"}'
```

---

### 3. e2e-user2-submit

**Purpose**: Submits 2 entries as User 2 (manuelurenah)

**Notes**: Requires testing-login authentication before running

**Actions**:
1. Selects 2 images from gallery
2. Submits entries

**Usage**:
```bash
# First authenticate, then run:
curl -X POST http://localhost:9222/flows/e2e-user2-submit/run \
  -d '{"profile": "civitai-local"}'  # Will need testing-login in session
```

---

### 4. e2e-user3-submit

**Purpose**: Submits 2 entries as User 3 (bkdiehl482)

**Notes**:
- Requires testing-login with userId 5
- Must filter for eligible images (some may be NSFW/ineligible)

**Actions**:
1. Opens Submit Entry modal
2. Waits for images to load
3. Selects 2 eligible images
4. Submits entries

---

### 5. e2e-user1-judge

**Purpose**: User 1 judges available pairs (from User 2 and User 3 entries)

**Actions**:
1. Navigates to judge page
2. Waits for pair images to load
3. Votes on 3 pairs using:
   - Keyboard shortcut "1" (vote left)
   - Keyboard shortcut "2" (vote right)
   - Vote button click
4. Captures final statistics

**Keyboard Shortcuts**:
- `1`: Vote for left image
- `2`: Vote for right image
- `Space`: Skip pair

---

### 6. e2e-user2-judge

**Purpose**: User 2 judges available pairs (from User 1 and User 3 entries)

**Actions**:
1. Navigates to judge page
2. Votes on 6 pairs using mixed methods
3. Captures final statistics

**Note**: User 2 can judge more pairs than User 1 because they can rate pairs between User 1 and User 3 (6 unique pairs vs 3-4 for User 1).

---

### 7. e2e-cancel-create

**Purpose**: Creates a crucible specifically for cancellation testing

**Parameters**:
- `Crucible Name`: e.g., "Cancellation Test"
- `Description`: Description text

**Differences from main create flow**:
- Entry fee: 50 Buzz (instead of 100)
- Entry limit: 2 entries per user

---

### 8. e2e-cancel-user1-submit & e2e-cancel-user2-submit

**Purpose**: Submit entries to the cancellation test crucible to build prize pool

**Actions**: Same as primary submission flows but targeting crucible #21

---

### 9. e2e-cancel-refund

**Purpose**: Cancels a crucible and verifies refunds

**Important**: There is no UI cancel button - cancellation is done via API

**Actions**:
1. Records initial Buzz balance
2. Calls cancel API via fetch:
   ```javascript
   await fetch('/api/trpc/crucible.cancel', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ json: { id: crucibleId } })
   });
   ```
3. Verifies Buzz balance restored (refund applied)

**API Response Format**:
```json
{
  "crucibleId": 21,
  "refundedEntries": 4,
  "totalRefunded": 200,
  "failedRefunds": []
}
```

## Running Flows

### List All Flows
```bash
curl http://localhost:9222/flows
```

### Run a Flow
```bash
curl -X POST http://localhost:9222/flows/{flow-name}/run \
  -d '{
    "profile": "member",
    "params": { ... }
  }'
```

### Run Flow in Debug Mode (in existing session)
```bash
curl -X POST "http://localhost:9222/run-flow?session=mySession" \
  -d '{"flow": "e2e-create-crucible", "params": {...}}'
```

## Test State File

Test state is persisted in `.browser/e2e-test-state.json` with:

- Crucible IDs and URLs
- User entry counts and Buzz spent
- Judging statistics
- Leaderboard snapshots
- Cancellation/refund verification data

## Known Issues

### Votes Not Persisting (CRITICAL)

During testing, a critical issue was discovered:
- `submitVote` API returns HTTP 200
- However, votes are not persisted to the database
- All ELO scores remain at initial 1500
- `CrucibleEntry.voteCount` stays at 0
- `crucible_votes` ClickHouse table is empty

**Impact**: Leaderboard rankings and prize distribution cannot be properly tested until this bug is fixed.

## Replay Considerations

### Order Dependency

Flows should be run in order for full E2E testing:
1. `e2e-create-crucible` (creates crucible #20)
2. `e2e-user1-submit` (adds entries)
3. `e2e-user2-submit` (adds entries)
4. `e2e-user3-submit` (adds entries)
5. `e2e-user1-judge` (rates pairs)
6. `e2e-user2-judge` (rates pairs)

### Crucible IDs Are Hardcoded

The flows reference specific crucible IDs (20, 21). For replay:
- Either use the same crucible IDs
- Or update `startUrl` in flow metadata before running

### Session State

Each flow assumes:
- User is already authenticated
- Page is at the correct starting URL
- Previous flows have completed (for dependent flows)

# Civitai Browser Testing Guide

Project-specific guidance for browser automation testing on the Civitai codebase.

## Authentication

### Testing Login (Dev Only)

Use the `testing-login` credential provider to quickly switch between users without OAuth:

```javascript
// Get CSRF token first
const csrf = await page.context().request.get("http://localhost:3000/api/auth/csrf").then(r => r.json());

// Login as specific user ID
const userId = '4'; // See test users below
await page.context().request.post("http://localhost:3000/api/auth/callback/testing-login", {
  form: { csrfToken: csrf.csrfToken, id: userId, callbackUrl: "http://localhost:3000" }
});

// Reload to apply session
await page.reload();
```

### Test Users

| User ID | Username | isModerator | Notes |
|---------|----------|-------------|-------|
| 1 | JustMaier | true | `member` profile |
| 4 | manuelurenah | true | Good for testing mod features |
| 5 | bkdiehl482 | true | Alternative mod user |
| 6 | koenb | true | Alternative mod user |

### Profiles

- **member**: Pre-authenticated as User 1 (JustMaier)
- **civitai-local**: May need re-authentication via testing-login
- **creator**: May need re-authentication via testing-login

## Feature Flags

Some features are gated by feature flags. In development:

| Feature | Dev Access | Prod Access |
|---------|------------|-------------|
| crucible | All users | mod, granted |

If you get 403 errors on crucible endpoints, ensure you're logged in as a moderator user.

## Architecture Notes

### Crucible Vote Storage

Votes use a two-phase persistence model:

1. **During active voting**: Data stored in Redis (system cache)
   - ELO scores: `crucible:elo:{crucibleId}`
   - Vote counts: `crucible:elo:{crucibleId}:votes`
   - Judges: `crucible:judges:{crucibleId}`

2. **During finalization**: Redis data synced to PostgreSQL
   - Runs via cron job when crucible ends
   - `CrucibleEntry.voteCount` and `CrucibleEntry.score` only update here

**Important**: If testing votes, check Redis during active voting, not PostgreSQL.

### ClickHouse Tracking

Event tracking requires `CLICKHOUSE_TRACKER_URL` env var. If not set, tracking silently skips (no-op).

## Common Issues

### Hydration Errors

React hydration errors (time mismatch) may appear as modal overlays. Close or minimize them to continue testing.

### 404 on Feature Pages

If a feature page returns 404:
1. Check feature flag access (see above)
2. Verify user has required permissions
3. Check if route exists in `src/pages/`

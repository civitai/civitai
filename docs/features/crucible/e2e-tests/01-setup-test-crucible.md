# US001 - Setup Test Crucible with Multiple Users' Entries

**Test Date**: 2026-01-17
**Status**: PARTIAL - Blocked by profile authentication

## Summary

This test attempted to create a crucible and submit entries from multiple users. The crucible was successfully created and entries were submitted from one user, but additional user profiles (civitai-local, creator) were not authenticated.

## Test Execution

### Step 1: Create Crucible ✅

**Profile**: member (JustMaier)
**URL**: http://localhost:3000/crucibles/create

Created crucible with settings:
- **Name**: E2E Rating Test - 20260117-100711
- **Duration**: 8 hours
- **Entry Fee**: 100 Buzz per entry
- **Entry Limit per User**: 2 entries
- **Max Total Entries**: Unlimited
- **Prize Distribution**: 1st: 50%, 2nd: 30%, 3rd: 20%
- **Content Level**: PG (SFW only)

**Result**: Crucible created successfully with ID **19**

### Step 2: Submit Entries as Member ✅

**Profile**: member (JustMaier)

Submitted 2 entries:
- Entry #1: Gingerbread character image (1500 pts initial ELO)
- Entry #2: Gingerbread character image (1500 pts initial ELO)

**Cost**: 200 Buzz total (100 x 2)

### Step 3: Submit Entries as civitai-local ❌ BLOCKED

**Profile**: civitai-local
**Issue**: Profile authentication expired - showed "Sign In" button instead of being logged in

### Step 4: Submit Entries as creator ❌ NOT ATTEMPTED

Blocked by same authentication issue as civitai-local.

## Crucible State After Test

| Metric | Value |
|--------|-------|
| Crucible ID | 19 |
| Prize Pool | 200 Buzz |
| Total Entries | 2 |
| Unique Participants | 1 |
| Time Remaining | ~8 hours |
| Status | ACTIVE NOW |

## Entry Details

| Entry # | User | Image | Initial ELO |
|---------|------|-------|-------------|
| 1 | @JustMaier | /AH36H71R5R... | 1500 |
| 2 | @JustMaier | /NH0RHADX3... | 1500 |

## Screenshots

Screenshots saved in: `.browser/sessions/8bfcecbb/screenshots/` and `.browser/sessions/707fe7f8/screenshots/`

Key screenshots:
- `004-navigate-crucibles-create.png` - Create form (Step 1)
- `011-chunk-click-next-to-step-3.png` - Prize distribution
- `012-chunk-click-next-to-step-4.png` - Review page
- `013-chunk-create-crucible.png` - Created crucible landing
- `015-chunk-click-submit-entry-button.png` - Entry selection modal
- `016-chunk-select-first-two-images.png` - 2 images selected
- `019-chunk-refresh-page.png` - Final state with 2 entries

## Blockers

### Profile Authentication Required

The following browser profiles need to be re-authenticated before multi-user testing can proceed:
- `civitai-local`
- `creator`

To re-authenticate profiles, run:
```bash
curl -X POST http://localhost:9222/sessions \
  -d '{"name": "auth", "url": "http://localhost:3000/login", "profile": "civitai-local"}'
# Then manually log in and run:
curl -X POST http://localhost:9222/save-auth \
  -d '{"profile": "civitai-local", "description": "Civitai local test user"}'
```

## Next Steps

1. Re-authenticate civitai-local and creator profiles
2. Re-run this test to submit entries from all 3 users
3. Proceed to US002 (Rating/Judging Flow) once 6 entries exist

## Findings

### Positive
- Crucible creation wizard works smoothly
- 4-step wizard (Basic Info → Entry Rules → Prizes → Review) is intuitive
- Entry submission modal correctly enforces entry limits
- Initial ELO scores (1500) are assigned correctly
- Prize pool accumulates correctly from entry fees

### Issues Noted
- None - all tested functionality worked as expected

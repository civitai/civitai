---
name: mod-actions
description: Take moderator actions on users - ban, mute, remove content, manage leaderboard eligibility. Use when you need to ban a user, mute them, or take other moderation actions.
---

# Moderator Actions

Take moderator actions on Civitai users including banning, muting, removing content, and managing leaderboard eligibility.

This skill uses the Civitai tRPC API with API key authentication, ensuring all actions go through the proper service layer with full side effects (session invalidation, search index updates, activity tracking, etc.).

## Setup

1. Copy `.env-example` to `.env` in this skill directory
2. Add your Civitai API key (must belong to a moderator account)
3. Optionally set the API URL (defaults to production)

```bash
cp .claude/skills/mod-actions/.env.example .claude/skills/mod-actions/.env
# Edit .env and add your API key
```

Get your API key from: https://civitai.com/user/account (API Keys section)

**Important:** The API key must belong to a user with moderator privileges.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CIVITAI_API_KEY` | Yes | - | Your Civitai API key |
| `CIVITAI_API_URL` | No | `https://civitai.com` | API base URL |

For local development, set `CIVITAI_API_URL=http://localhost:3000`

## Running Commands

```bash
node .claude/skills/mod-actions/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `user <id\|username>` | Look up user info by ID or username |
| `ban <id\|username>` | Ban a user (toggle - will unban if already banned) |
| `mute <id\|username>` | Mute a user (toggle - will unmute if already muted) |
| `leaderboard <id\|username> <true\|false>` | Set leaderboard eligibility |
| `remove-content <id\|username>` | Remove all content from a user |

### Ban Reason Codes

| Code | Description |
|------|-------------|
| `SexualMinor` | Sexual content involving minors |
| `SexualMinorGenerator` | Generator for sexual minor content |
| `SexualMinorTraining` | Training on sexual minor content |
| `SexualPOI` | Sexual content with people of interest |
| `Bestiality` | Bestiality content |
| `Scat` | Scat content |
| `Nudify` | Nudification tools |
| `Harassment` | Harassment |
| `LeaderboardCheating` | Leaderboard manipulation |
| `BuzzCheating` | Buzz system abuse |
| `RRDViolation` | Rights and Restrictions Denial violation |
| `Other` | Other violation |

### Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON response |
| `--dry-run` | Show what would be done without making changes |
| `--reason <code>` | Ban reason code (for ban command) |
| `--message <text>` | External message shown to user (for ban command) |
| `--internal <text>` | Internal notes (for ban command) |

## Examples

### Look Up User

```bash
# By user ID
node .claude/skills/mod-actions/query.mjs user 3879899

# By username
node .claude/skills/mod-actions/query.mjs user unfazedanomaly964

# Get raw JSON
node .claude/skills/mod-actions/query.mjs user 3879899 --json
```

### Ban User

```bash
# Simple ban (toggles ban status)
node .claude/skills/mod-actions/query.mjs ban 3879899

# Ban with reason and message
node .claude/skills/mod-actions/query.mjs ban 3879899 --reason Other --message "Repeated ToS violations"

# Ban with internal notes
node .claude/skills/mod-actions/query.mjs ban 3879899 --reason Other --message "ToS violation" --internal "User exploited republish bug 15 times"

# Ban by username
node .claude/skills/mod-actions/query.mjs ban unfazedanomaly964 --reason Other

# Dry run to see what would happen
node .claude/skills/mod-actions/query.mjs ban 3879899 --dry-run
```

### Mute User

```bash
# Toggle mute status
node .claude/skills/mod-actions/query.mjs mute 3879899

# By username
node .claude/skills/mod-actions/query.mjs mute unfazedanomaly964

# Dry run
node .claude/skills/mod-actions/query.mjs mute 3879899 --dry-run
```

### Manage Leaderboard Eligibility

```bash
# Exclude from leaderboards
node .claude/skills/mod-actions/query.mjs leaderboard 3879899 false

# Include in leaderboards
node .claude/skills/mod-actions/query.mjs leaderboard 3879899 true

# Dry run
node .claude/skills/mod-actions/query.mjs leaderboard 3879899 false --dry-run
```

### Remove All Content

```bash
# Remove all content from a user (DESTRUCTIVE)
node .claude/skills/mod-actions/query.mjs remove-content 3879899

# Always dry run first!
node .claude/skills/mod-actions/query.mjs remove-content 3879899 --dry-run
```

## Output Format

### User Info

```
User: unfazedanomaly964
ID: 3879899
Status: Active
Banned: No
Muted: No
Leaderboard Eligible: Yes
Created: 2024-03-19
```

### Action Result

```
Action: BAN
User: unfazedanomaly964 (ID: 3879899)
Success: Yes
Previous: Not Banned
Now: Banned
Reason: Other
```

## How It Works

This skill calls the Civitai tRPC API endpoints:
- `user.getById` / `user.getCreator` - User lookups
- `user.toggleBan` - Ban/unban users
- `user.toggleMute` - Mute/unmute users
- `user.setLeaderboardEligibility` - Manage leaderboard access
- `user.removeAllContent` - Remove all user content

Authentication is via Bearer token in the Authorization header:
```
Authorization: Bearer <your-api-key>
```

All endpoints require `moderatorProcedure` access, meaning the API key must belong to a moderator account.

## When to Use

- **Investigating violations**: Look up user info before taking action
- **Repeat offenders**: Ban users who repeatedly violate ToS
- **Temporary restrictions**: Mute users for minor violations
- **Leaderboard manipulation**: Exclude cheaters from leaderboards
- **Content violations**: Remove all content from severe violators

## Safety Notes

- **Always use `--dry-run` first** for destructive actions
- All actions are logged in the ModActivity table
- Ban actions invalidate user sessions immediately
- Universal bans unpublish all user content and cancel subscriptions
- Document reasons with `--reason` and `--message` flags
- API key must have moderator privileges

## Tips

- Always look up user info first to confirm the right user
- Use `--dry-run` for destructive actions like bans and content removal
- Document reasons with `--reason`, `--message`, and `--internal` flags
- Use `--json` for scripting or piping to other tools
- Set `CIVITAI_API_URL=http://localhost:3000` for local development

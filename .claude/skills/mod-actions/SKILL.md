---
name: mod-actions
description: "Comprehensive moderation toolkit: user actions (ban/mute/DM), strike system, image moderation, report handling, generation moderation, content/training moderation, and NCMEC/CSAM reporting. All via Civitai tRPC API."
---

# Moderator Actions

Comprehensive moderation toolkit for Civitai. Covers user actions, strike management, image moderation, report handling, generation moderation, content/training moderation, and NCMEC/CSAM reporting.

All scripts use the Civitai tRPC API with Bearer token authentication, ensuring actions go through the proper service layer with full side effects.

## Setup

1. Copy `.env-example` to `.env` in this skill directory
2. Add your Civitai API key (must belong to a moderator account)
3. Optionally set the API URL (defaults to production)

```bash
cp .claude/skills/mod-actions/.env.example .claude/skills/mod-actions/.env
# Edit .env and add your API key
```

**Important:** The API key must belong to a user with moderator privileges.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CIVITAI_API_KEY` | Yes | - | Your Civitai API key |
| `CIVITAI_API_URL` | No | `https://civitai.com` | API base URL |

---

## Skill Files

| File | Domain | Commands |
|------|--------|----------|
| `query.mjs` | User moderation | user, ban, mute, leaderboard, remove-content, dm |
| `strikes.mjs` | Strike system | get-user, standings, list, create, void |
| `images.mjs` | Image moderation | review-queue, review-counts, moderate, tos-violation, rescan, report-csam, poi-tags, user-images, rating-requests, ingestion-errors, resolve-ingestion, downleveled, pending-ingestion, toggle-flag |
| `reports.mjs` | Report handling | list, set-status, bulk-status, update, appeals, appeal-details, resolve-appeal |
| `generation.mjs` | Generation moderation | flagged-consumers, flagged-reasons, consumer-strikes, review-strikes, user-generations, restrictions, resolve-restriction, allowlist-add, debug-audit, todays-counts, suspicious-matches |
| `content.mjs` | Content & training | models, flagged-models, resolve-flagged, model-versions, rescan-model, restore-model, toggle-cannot-promote, toggle-cannot-publish, articles, training-models, approve-training, deny-training, mod-rule |
| `csam.mjs` | NCMEC/CSAM reporting | reports, stats, image-resources, create-report |

---

## query.mjs — User Moderation

```bash
node .claude/skills/mod-actions/query.mjs <command> [options]
```

| Command | Description |
|---------|-------------|
| `user <id\|username>` | Look up user info |
| `ban <id\|username>` | Toggle ban status |
| `mute <id\|username>` | Toggle mute status |
| `leaderboard <id\|username> <true\|false>` | Set leaderboard eligibility |
| `remove-content <id\|username>` | Remove all user content (DESTRUCTIVE) |
| `dm <id\|username>` | Send a DM (requires `--message`) |

**Options:** `--json`, `--dry-run`, `--reason <code>`, `--message <text>`, `--internal <text>`

**Ban Reason Codes:** SexualMinor, SexualMinorGenerator, SexualMinorTraining, SexualPOI, Bestiality, Scat, Nudify, Harassment, LeaderboardCheating, BuzzCheating, RRDViolation, Other

```bash
node .claude/skills/mod-actions/query.mjs user 3879899
node .claude/skills/mod-actions/query.mjs ban 3879899 --reason Other --message "ToS violation" --dry-run
node .claude/skills/mod-actions/query.mjs dm 3879899 --message "Please review our guidelines"
```

---

## strikes.mjs — Strike System

```bash
node .claude/skills/mod-actions/strikes.mjs <command> [options]
```

| Command | R/W | Description |
|---------|-----|-------------|
| `get-user <userId>` | READ | Strike history for a user |
| `standings` | READ | User standings (filter: active/muted/flagged) |
| `list` | READ | Paginated strike list with filters |
| `create <userId>` | WRITE | Issue a strike (requires `--reason`, `--description`) |
| `void <strikeId>` | WRITE | Void a strike (requires `--reason`) |

**Strike Reasons:** BlockedContent, RealisticMinorContent, CSAMContent, TOSViolation, HarassmentContent, ProhibitedContent, ManualModAction

**Options:** `--reason`, `--description`, `--points <1-3>`, `--entity-type`, `--entity-id`, `--report-id`, `--expires-days`, `--status <Active,Expired,Voided>`, `--sort <points|score|lastStrike|created>`, `--sort-order <asc|desc>`, `--flagged-for-review`, `--has-active-strikes`, `--page`, `--limit`, `--json`, `--dry-run`

```bash
node .claude/skills/mod-actions/strikes.mjs get-user 3879899
node .claude/skills/mod-actions/strikes.mjs standings --has-active-strikes --limit 10
node .claude/skills/mod-actions/strikes.mjs create 3879899 --reason BlockedContent --description "Uploaded prohibited content" --points 1 --dry-run
node .claude/skills/mod-actions/strikes.mjs void 42 --reason "False positive from scanner"
```

---

## images.mjs — Image Moderation

```bash
node .claude/skills/mod-actions/images.mjs <command> [options]
```

| Command | R/W | Description |
|---------|-----|-------------|
| `review-queue` | READ | Image review queue |
| `review-counts` | READ | Queue tab counts |
| `moderate <ids> <action>` | WRITE | Block/unblock images |
| `tos-violation <imageId>` | WRITE | Flag as TOS violation |
| `rescan <imageId>` | WRITE | Re-ingest/rescan image |
| `report-csam <imageIds>` | WRITE | Report images as CSAM |
| `poi-tags` | READ | Person-of-interest tags |
| `user-images <userId>` | READ | All images for a user |
| `rating-requests` | READ | NSFW rating review requests |
| `ingestion-errors` | READ | Images with ingestion errors |
| `resolve-ingestion <id>` | WRITE | Resolve ingestion error |
| `downleveled` | READ | Downleveled images |
| `pending-ingestion` | READ | Pending ingestion images |
| `toggle-flag <imageId>` | WRITE | Toggle image flag |

**Options:** `--ids`, `--action`, `--review-type`, `--cursor`, `--page`, `--limit`, `--json`, `--dry-run`

```bash
node .claude/skills/mod-actions/images.mjs review-counts
node .claude/skills/mod-actions/images.mjs review-queue --limit 20
node .claude/skills/mod-actions/images.mjs moderate 12345,67890 block --dry-run
node .claude/skills/mod-actions/images.mjs user-images 3879899 --json
node .claude/skills/mod-actions/images.mjs rescan 12345
```

---

## reports.mjs — Report Handling

```bash
node .claude/skills/mod-actions/reports.mjs <command> [options]
```

| Command | R/W | Description |
|---------|-----|-------------|
| `list` | READ | Reports by entity type (requires `--type`) |
| `set-status <reportId> <status>` | WRITE | Set report status |
| `bulk-status <status>` | WRITE | Bulk update statuses (requires `--ids`) |
| `update <reportId>` | WRITE | Update report with status/notes |
| `appeals` | READ | Recent appeals |
| `appeal-details <id>` | READ | Appeal details |
| `resolve-appeal` | WRITE | Resolve appeal (requires `--ids`, `--entity-type`, `--status`) |

**Report Entity Types:** model, comment, commentV2, image, resourceReview, article, post, reportedUser, collection, bounty, bountyEntry, chat, comicProject

**Report Statuses:** Pending, Processing, Actioned, Unactioned

**Appeal Statuses:** Pending, Approved, Rejected

**Options:** `--type`, `--status`, `--ids`, `--entity-type`, `--internal`, `--message`, `--user-id`, `--start-date`, `--page`, `--limit`, `--query`, `--json`, `--dry-run`

```bash
node .claude/skills/mod-actions/reports.mjs list --type image --limit 20
node .claude/skills/mod-actions/reports.mjs set-status 456 Actioned --dry-run
node .claude/skills/mod-actions/reports.mjs bulk-status Actioned --ids 1,2,3
node .claude/skills/mod-actions/reports.mjs appeals --user-id 3879899
node .claude/skills/mod-actions/reports.mjs resolve-appeal --ids 10,11 --entity-type Image --status Approved
```

---

## generation.mjs — Generation Moderation

```bash
node .claude/skills/mod-actions/generation.mjs <command> [options]
```

| Command | R/W | Description |
|---------|-----|-------------|
| `flagged-consumers` | READ | Flagged generation consumers |
| `flagged-reasons` | READ | Flagging reasons |
| `consumer-strikes <userId>` | READ | Consumer's generation strikes |
| `review-strikes <userId>` | WRITE | Mark strikes as reviewed |
| `user-generations <userId>` | READ | User's generated images |
| `restrictions` | READ | All generation restrictions |
| `resolve-restriction <id>` | WRITE | Resolve restriction (Upheld/Overturned) |
| `allowlist-add` | WRITE | Add prompt trigger to allowlist |
| `debug-audit <prompt>` | READ | Test prompt auditing |
| `todays-counts` | READ | Today's prohibited request counts |
| `suspicious-matches` | READ | Saved suspicious audit matches |

**Options:** `--status <Pending|Upheld|Overturned>`, `--reason`, `--start-date`, `--message`, `--trigger`, `--category`, `--negative-prompt`, `--user-id`, `--username`, `--restriction-id`, `--page`, `--limit`, `--json`, `--dry-run`

```bash
node .claude/skills/mod-actions/generation.mjs flagged-consumers
node .claude/skills/mod-actions/generation.mjs consumer-strikes 3879899
node .claude/skills/mod-actions/generation.mjs restrictions --status Pending
node .claude/skills/mod-actions/generation.mjs resolve-restriction 42 --status Upheld --message "Confirmed violation" --dry-run
node .claude/skills/mod-actions/generation.mjs debug-audit "some prompt text"
node .claude/skills/mod-actions/generation.mjs allowlist-add --trigger "girl" --category "age" --reason "False positive"
```

---

## content.mjs — Content & Training Moderation

```bash
node .claude/skills/mod-actions/content.mjs <command> [options]
```

| Command | R/W | Description |
|---------|-----|-------------|
| `models` | READ | Models for mod review |
| `flagged-models` | READ | Flagged models |
| `resolve-flagged` | WRITE | Resolve flagged models (requires `--ids`) |
| `model-versions` | READ | Model versions for mod |
| `rescan-model <id>` | WRITE | Re-ingest a model |
| `restore-model <id>` | WRITE | Restore deleted model |
| `toggle-cannot-promote <id>` | WRITE | Toggle promotion eligibility |
| `toggle-cannot-publish <id>` | WRITE | Toggle publish ability |
| `articles` | READ | Articles for mod review |
| `training-models` | READ | Training models for review |
| `approve-training <id>` | WRITE | Approve training data |
| `deny-training <id>` | WRITE | Deny training data |
| `mod-rule <id>` | READ | Get moderation rule |

**Options:** `--ids`, `--page`, `--limit`, `--json`, `--dry-run`

```bash
node .claude/skills/mod-actions/content.mjs flagged-models --limit 10
node .claude/skills/mod-actions/content.mjs resolve-flagged --ids 1,2,3 --dry-run
node .claude/skills/mod-actions/content.mjs training-models --limit 20
node .claude/skills/mod-actions/content.mjs approve-training 456
node .claude/skills/mod-actions/content.mjs rescan-model 789
```

---

## csam.mjs — NCMEC/CSAM Reporting

```bash
node .claude/skills/mod-actions/csam.mjs <command> [options]
```

| Command | R/W | Description |
|---------|-----|-------------|
| `reports` | READ | Paginated CSAM reports |
| `stats` | READ | CSAM report statistics |
| `image-resources <imageIds>` | READ | Resources used to generate flagged images |
| `create-report <userId>` | WRITE | Create NCMEC CyberTipline report |

**CSAM Report Types:** Image, TrainingData, GeneratedImage

**Options:** `--type <CsamReportType>`, `--image-ids <id1,id2,...>`, `--minor-depiction <real|non-real>`, `--page`, `--limit`, `--json`, `--dry-run`

```bash
node .claude/skills/mod-actions/csam.mjs stats
node .claude/skills/mod-actions/csam.mjs reports --limit 10
node .claude/skills/mod-actions/csam.mjs image-resources 12345,67890
node .claude/skills/mod-actions/csam.mjs create-report 3879899 --type GeneratedImage --image-ids 111,222 --dry-run
```

---

## Global Options

All scripts support:

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON (for agent/scripting consumption) |
| `--dry-run` | Preview WRITE actions without executing |
| `--page <n>` | Page number for paginated results (default: 1) |
| `--limit <n>` | Page size for paginated results (default: 20) |

## Safety Notes

- **Always use `--dry-run` first** for destructive/write actions
- All actions are logged in the ModActivity table
- Ban actions invalidate user sessions immediately
- CSAM reports are submitted to NCMEC — use with extreme care
- Document reasons with `--reason` and `--message` flags
- API key must have moderator privileges
- Use `--json` for programmatic consumption by agent daemons

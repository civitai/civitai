---
name: freshdesk
description: Interact with Freshdesk support platform - search/view/update tickets, reply to customers, add notes, look up contacts, and manage Knowledge Base articles. Use when you need to manage support tickets, look up customer information, or work with KB content.
model: claude-sonnet-4-6
---

# Freshdesk

Interact with the Freshdesk customer support platform via the v2 REST API. Search tickets, view conversations, reply to customers, add internal notes, update ticket properties, look up contacts, and manage Knowledge Base articles.

## Setup

1. Copy `.env.example` to `.env` in this skill directory
2. Add your Freshdesk API key and domain

```bash
cp .claude/skills/freshdesk/.env.example .claude/skills/freshdesk/.env
# Edit .env and add your credentials
```

Get your API key from: Freshdesk Admin > Profile Settings > Your API Key

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FRESHDESK_TOKEN` | Yes | - | Your Freshdesk API key |
| `FRESHDESK_DOMAIN` | Yes | - | Your Freshdesk domain (e.g., `https://yourcompany.freshdesk.com`) |

## Running Commands

```bash
node .claude/skills/freshdesk/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `tickets` | List recent tickets (default: 30, filterable) |
| `ticket <id>` | Get ticket details with requester info |
| `search <query>` | Search tickets (Freshdesk query syntax) |
| `conversations <id>` | View ticket conversations (replies + notes) |
| `investigate <id>` | Full ticket investigation (ticket + conversations + contact in one call) |
| `reply <id> <message>` | Reply to a ticket (visible to customer) |
| `note <id> <message>` | Add an internal note (not visible to customer) |
| `update <id>` | Update ticket properties (status, priority, etc.) |
| `contact <id\|email>` | Look up a contact by ID or email |
| `contacts <query>` | Search contacts by name, email, or phone |
| **Knowledge Base** | |
| `kb-categories` | List all KB categories |
| `kb-folders <category_id>` | List folders in a category |
| `kb-articles <folder_id>` | List articles in a folder |
| `kb-article <article_id>` | View a single KB article |
| `kb-search <term>` | Search KB articles |
| `kb-create <folder_id> <title>` | Create an article in a folder |
| `kb-update <article_id>` | Update an article |

### Ticket Status Codes

| Code | Status |
|------|--------|
| `2` | Open |
| `3` | Pending |
| `4` | Resolved |
| `5` | Closed |

### Ticket Priority Codes

| Code | Priority |
|------|----------|
| `1` | Low |
| `2` | Medium |
| `3` | High |
| `4` | Urgent |

### Article Status Codes

| Code | Status |
|------|--------|
| `1` | Draft |
| `2` | Published |

### Options

| Flag | Description | Applies To |
|------|-------------|------------|
| `--json` | Output raw JSON response | All commands |
| `--status <code>` | Filter by status (2=Open, 3=Pending, 4=Resolved, 5=Closed) | `tickets` |
| `--priority <code>` | Filter by priority (1=Low, 2=Medium, 3=High, 4=Urgent) | `tickets` |
| `--page <n>` | Page number for paginated results | `tickets` |
| `--set-status <code>` | Set ticket status | `update` |
| `--set-priority <code>` | Set ticket priority | `update` |
| `--set-agent <id>` | Assign ticket to agent ID | `update` |
| `--set-group <id>` | Assign ticket to group ID | `update` |
| `--set-type <type>` | Set ticket type | `update` |
| `--set-tag <tag>` | Set ticket tag (replaces existing tags) | `update` |
| `--private` | Make a note private (default for notes) | `note` |
| `--body <text>` | Article body/description (HTML supported) | `kb-create`, `kb-update` |
| `--set-title <text>` | Set article title | `kb-update` |
| `--set-article-status <1\|2>` | Article status: 1=draft, 2=published | `kb-create`, `kb-update` |

## Examples

### List & Search Tickets

```bash
# List recent tickets
node .claude/skills/freshdesk/query.mjs tickets

# Filter by status (open tickets only)
node .claude/skills/freshdesk/query.mjs tickets --status 2

# Filter by priority (urgent)
node .claude/skills/freshdesk/query.mjs tickets --priority 4

# Search tickets with Freshdesk query syntax
node .claude/skills/freshdesk/query.mjs search "status:2 AND priority:4"

# Search by requester email
node .claude/skills/freshdesk/query.mjs search "email:'user@example.com'"

# Search by subject keyword
node .claude/skills/freshdesk/query.mjs search "subject:'payment issue'"

# Get raw JSON
node .claude/skills/freshdesk/query.mjs tickets --json
```

### View Ticket Details

```bash
# Get ticket details
node .claude/skills/freshdesk/query.mjs ticket 12345

# View conversation history
node .claude/skills/freshdesk/query.mjs conversations 12345

# Full investigation (ticket + conversations + contact)
node .claude/skills/freshdesk/query.mjs investigate 12345

# Investigation as JSON (returns { ticket, conversations, contact })
node .claude/skills/freshdesk/query.mjs investigate 12345 --json

# Raw JSON output
node .claude/skills/freshdesk/query.mjs ticket 12345 --json
```

### Reply & Notes

```bash
# Reply to a ticket (visible to customer)
node .claude/skills/freshdesk/query.mjs reply 12345 "Thanks for reaching out! We're looking into this."

# Add an internal note (not visible to customer)
node .claude/skills/freshdesk/query.mjs note 12345 "Checked user account - subscription is active, issue is with billing sync"
```

### Update Tickets

```bash
# Change status to Pending
node .claude/skills/freshdesk/query.mjs update 12345 --set-status 3

# Set priority to High
node .claude/skills/freshdesk/query.mjs update 12345 --set-priority 3

# Assign to agent
node .claude/skills/freshdesk/query.mjs update 12345 --set-agent 67890

# Multiple updates at once
node .claude/skills/freshdesk/query.mjs update 12345 --set-status 2 --set-priority 3 --set-agent 67890
```

### Contact Lookup

```bash
# Look up by email
node .claude/skills/freshdesk/query.mjs contact user@example.com

# Look up by contact ID
node .claude/skills/freshdesk/query.mjs contact 98765

# Search contacts
node .claude/skills/freshdesk/query.mjs contacts "john"

# Raw JSON
node .claude/skills/freshdesk/query.mjs contact user@example.com --json
```

### Knowledge Base

```bash
# List all KB categories
node .claude/skills/freshdesk/query.mjs kb-categories

# List folders in a category
node .claude/skills/freshdesk/query.mjs kb-folders 12345

# List articles in a folder
node .claude/skills/freshdesk/query.mjs kb-articles 67890

# View a single article
node .claude/skills/freshdesk/query.mjs kb-article 111

# Search KB articles
node .claude/skills/freshdesk/query.mjs kb-search "billing"

# Create a new article (draft by default)
node .claude/skills/freshdesk/query.mjs kb-create 67890 "How to Reset Password" --body "<p>Steps to reset your password...</p>"

# Create a published article
node .claude/skills/freshdesk/query.mjs kb-create 67890 "Getting Started" --body "<p>Welcome guide...</p>" --set-article-status 2

# Update an article's title and body
node .claude/skills/freshdesk/query.mjs kb-update 111 --set-title "Updated Title" --body "<p>New content</p>"

# Publish a draft article
node .claude/skills/freshdesk/query.mjs kb-update 111 --set-article-status 2

# Get raw JSON
node .claude/skills/freshdesk/query.mjs kb-categories --json
```

## Output Format

### Ticket List

```
ID     | Status  | Priority | Subject                    | Requester
-------|---------|----------|----------------------------|------------------
12345  | Open    | High     | Can't upload models        | user@example.com
12346  | Pending | Medium   | Billing question           | other@example.com
```

### Ticket Detail

```
Ticket #12345
Subject: Can't upload models
Status: Open | Priority: High | Type: Problem
Requester: user@example.com
Created: 2025-01-15 | Updated: 2025-01-16
Tags: upload, bug
Description:
  I'm trying to upload a model but getting an error...
```

### Conversation

```
--- Reply by Agent (2025-01-16 10:30) ---
Thanks for reporting this. Can you share the error message?

--- Reply by Customer (2025-01-16 11:45) ---
Sure, it says "File too large"...

--- Note (private) by Agent (2025-01-16 12:00) ---
User is on free tier, file size limit applies.
```

## Freshdesk Search Query Syntax

The `search` command uses Freshdesk's query language:

| Query | Description |
|-------|-------------|
| `"status:2"` | Open tickets |
| `"priority:4"` | Urgent tickets |
| `"agent_id:123"` | Tickets assigned to agent |
| `"group_id:456"` | Tickets in group |
| `"tag:'billing'"` | Tickets with tag |
| `"created_at:>'2025-01-01'"` | Created after date |
| `"email:'user@example.com'"` | By requester email |
| `"status:2 AND priority:3"` | Combine with AND/OR |

## When to Use

- **Investigating user issues**: Look up tickets to understand customer problems
- **Responding to support**: Reply to tickets or add internal notes
- **Ticket management**: Update status, priority, assignments
- **Customer lookup**: Find contact info and ticket history
- **Support analytics**: Search and filter tickets by various criteria
- **Knowledge Base management**: Browse, search, create, and update KB articles

## Safety Guardrails

**CRITICAL**: The following actions require explicit human confirmation and must NEVER be performed automatically.

### Forbidden Auto-Actions

These actions must be flagged as `[REQUIRES HUMAN ACTION]` and never executed without explicit human approval:

| Action | Risk | Handling |
|--------|------|----------|
| Refunds (Stripe, Paddle, Buzz) | Financial | Flag and defer to human |
| Free Buzz grants | Financial | Flag and defer to human |
| Free subscriptions or upgrades | Financial | Flag and defer to human |
| Account deletion | Irreversible | Flag and defer to human |
| Password resets / email changes | Security | Flag and defer to human |
| Subscription cancellation | Financial | Flag and defer to human |
| Unbanning users | Safety | Flag and defer to human |
| Any monetary or financial action | Financial | Flag and defer to human |

### Behavior When Encountered

1. **Flag it**: Mark the action as `[REQUIRES HUMAN ACTION]` in your response
2. **Never promise**: Do not tell the customer the action will be taken
3. **Draft safely**: Write reply drafts that acknowledge the request without committing to the action (e.g., "I've escalated your refund request to our team" NOT "Your refund has been processed")
4. **Recommend manual handling**: Tell the support agent which team/person should handle it

### Safe Actions (OK to perform)

- Read-only lookups (tickets, contacts, user data via postgres/clickhouse)
- Adding internal notes to tickets
- Updating ticket status and priority
- Creating ClickUp tasks for engineering issues
- Drafting reply text for human review

---

## Cross-Platform Workflows

### Investigation Workflow

Use this workflow when a support ticket needs full context before responding.

**Steps:**

1. Run `investigate <ticket-id>` to get ticket + conversations + contact in one call
2. Extract the Civitai user ID from the contact's `unique_external_id` field (format: `civitai-{userId}`)
3. Query postgres for user account details:
   ```bash
   # Use /postgres-query skill
   SELECT id, username, email, "bannedAt", "muted", "createdAt" FROM "User" WHERE id = {userId};
   ```
4. Query postgres for subscription info:
   ```bash
   SELECT * FROM "CustomerSubscription" WHERE "userId" = {userId} ORDER BY "createdAt" DESC LIMIT 1;
   ```
5. Optionally query ClickHouse for recent activity:
   ```bash
   # Use /clickhouse-query skill — see "Common ClickHouse Queries" below for real table names
   SELECT * FROM views WHERE visitorId = {userId} ORDER BY createdAt DESC LIMIT 20;
   ```
6. Present a unified summary with:
   - Issue classification (see Triage table below)
   - User account status (active, banned, muted, subscription tier)
   - Relevant history from conversations
   - Any `[REQUIRES HUMAN ACTION]` flags for forbidden actions

### Triage Workflow

Use this classification table to route tickets appropriately:

| Issue Type | Priority | Routing | Notes |
|-----------|----------|---------|-------|
| Buzz / Payment issues | High | Support (financial) | `[REQUIRES HUMAN ACTION]` for refunds |
| Upload / Publishing errors | Medium | Engineering if bug confirmed | Create ClickUp task if reproducible |
| Account Access (login, 2FA) | High | Support | `[REQUIRES HUMAN ACTION]` for password/email changes |
| Content Moderation (reports, takedowns) | Medium | Moderation team | Check `/mod-actions` for history |
| Legal / DMCA | Urgent | Legal / Compliance | Never handle directly, escalate immediately |
| Bug Report | Medium-High | ClickUp + Engineering | Create task with repro steps |
| Feature Request | Low | ClickUp task | Tag as feature-request |

### Draft Reply Workflow

Use this when composing a customer-facing response.

**Steps:**

1. Run `investigate <ticket-id>` for full context
2. Identify the issue type and current resolution state
3. Draft an empathetic, professional response:
   - Acknowledge the user's frustration or question
   - Summarize what you found (without exposing internal details)
   - Explain next steps clearly
   - **Never promise forbidden actions** (refunds, free Buzz, etc.)
4. Present the draft for human review — **never auto-send replies**
5. Only send with explicit approval from the support agent

### ClickUp Integration Workflow

Use when a ticket reveals a bug or engineering issue that needs tracking.

**Steps:**

1. Create a ClickUp task using the `/clickup` skill:
   - **Title**: Brief description of the bug/issue
   - **Description**: Include repro steps from the ticket, Freshdesk ticket number, affected user ID
   - **Priority**: Based on triage severity
2. Add an internal note to the Freshdesk ticket linking to the ClickUp task:
   ```bash
   node .claude/skills/freshdesk/query.mjs note {ticket-id} "ClickUp task created: {task-url} - Tracking as engineering issue"
   ```
3. Optionally assign the ClickUp task to the relevant engineer

### Discord Notification Workflow

Use when critical or systemic issues are detected that need team awareness.

**When to trigger:**
- 3+ similar tickets received within 1 hour (pattern detected)
- Service outage indicators (multiple users reporting same failure)
- Payment system issues affecting multiple users

**Steps:**

1. Identify the pattern (similar error messages, same feature affected, same timeframe)
2. Use the `/discord` skill to send a rich embed to the appropriate channel:
   - **Ticket count**: How many tickets match the pattern
   - **Sample ticket**: Link/ID of a representative ticket
   - **Affected feature**: Which part of the platform is impacted
   - **Impact description**: Brief summary of user impact

**Channel routing guidance:**
- Engineering alerts → service outages, infrastructure issues, critical bugs
- Moderation → abuse reports, content policy violations
- Support → general ticket volume spikes, payment issues

---

## Civitai User Lookup Reference

### Freshdesk → Civitai Mapping

Freshdesk contacts are linked to Civitai accounts via the `unique_external_id` field:
- Format: `civitai-{userId}` (e.g., `civitai-12345` → Civitai user ID `12345`)
- The `investigate` command extracts this automatically in the Quick Reference section

### Common Postgres Queries

```sql
-- Find user by email
SELECT id, username, email, "bannedAt", "muted", "createdAt" FROM "User" WHERE email = 'user@example.com';

-- Find user by ID
SELECT id, username, email, "bannedAt", "muted", "createdAt" FROM "User" WHERE id = 12345;

-- Check active subscription
SELECT cs.*, p.name as "productName"
FROM "CustomerSubscription" cs
LEFT JOIN "Product" p ON cs."productId" = p.id
WHERE cs."userId" = 12345 AND cs."status" = 'active';

-- Check recent purchases
SELECT * FROM "Purchase" WHERE "userId" = 12345 ORDER BY "createdAt" DESC LIMIT 10;
```

> **Note**: Buzz balances are NOT stored in PostgreSQL. They are managed by an external Buzz microservice. Use the application's Buzz API endpoints or check the user's account via the admin dashboard.

### Common ClickHouse Queries

Real ClickHouse tables used in the codebase (use `/clickhouse-query` skill):

```sql
-- Recent page views by a user
SELECT * FROM views WHERE visitorId = 12345 ORDER BY createdAt DESC LIMIT 20;

-- User actions (tips, purchases, etc.)
SELECT * FROM actions WHERE userId = 12345 ORDER BY createdAt DESC LIMIT 20;

-- Model events (downloads, publishes, etc.)
SELECT * FROM modelEvents WHERE userId = 12345 ORDER BY createdAt DESC LIMIT 20;

-- User activities (registration, login, account changes)
SELECT * FROM userActivities WHERE userId = 12345 ORDER BY createdAt DESC LIMIT 20;
```

### Other Skill References

- **Mod actions**: Use `/mod-actions` to check moderation history or take moderation actions. Banning is a safe action, but **unbanning requires `[REQUIRES HUMAN ACTION]`**
- **Redis debugging**: Use `/redis-inspect` to check session data or cache state
- **Retool data**: Use `/retool-query` for moderation notes and user notes from the Retool database

### Subscription Tier Reference

| Tier | Description |
|------|-------------|
| Free | Default, no subscription |
| Supporter | Basic paid tier |
| Bronze | Mid-level tier |
| Silver | Higher tier |
| Gold | Premium tier |
| Buzz Purchaser | One-time Buzz purchase, not a subscription |

---

## Tips

- Use `search` with Freshdesk query syntax for advanced filtering
- Always check `conversations` to see full ticket history before replying
- Use `note` for internal team comments (not visible to customers)
- Use `reply` for customer-facing responses
- Combine `--set-status` with `reply` workflow: reply first, then update status
- Contact lookup by email is the most reliable method

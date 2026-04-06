---
name: discord
description: Post announcements and messages to Discord channels. Use when sharing updates, releases, or team communications.
---

# Discord

Post messages and announcements to Discord channels via the REST API. Navigate channels by name, send formatted messages with embeds, manage reactions, threads, and more.

## Setup

Run the setup script to authenticate via Discord:

```bash
node .claude/skills/discord/setup.mjs https://discord-proxy.civitai.com
```

This will:
1. Open your browser for Discord authentication
2. Verify you're in the team server
3. Save your personal API token to `.env`

### Admin Only: Direct Bot Token

If you manage the bot directly and need to bypass the proxy:

1. Copy `.env.example` to `.env` in this skill directory
2. Uncomment and set `DISCORD_BOT_TOKEN`
3. Optionally set `DISCORD_GUILD` for auto-detection

```bash
cp .claude/skills/discord/.env.example .claude/skills/discord/.env
```

## Running Commands

```bash
node .claude/skills/discord/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `guilds` | List all guilds (servers) the bot is in |
| `channels [guild]` | List text channels in a guild |
| `send <channel> "message"` | Send a plain text message |
| `announce <channel> "message"` | Send a formatted announcement embed |
| `me` | Show bot information |
| `users` | List all members in the guild |
| `user <name\|id>` | Get user info and mention format |
| `roles` | List all roles in the guild |
| `role <name\|id>` | Get role info and mention format |
| `messages <channel>` | Get recent messages from a channel |
| `edit <msg_link> "content"` | Edit a message (bot's own only) |
| `delete <msg_link>` | Delete a message |
| `reply <msg_link> "content"` | Reply to a message |
| `rich-embed <channel>` | Send embed with structured fields |
| `react <msg_link> <emoji>` | Add reaction to a message |
| `unreact <msg_link> <emoji>` | Remove reaction from a message |
| `pin <msg_link>` | Pin a message |
| `unpin <msg_link>` | Unpin a message |
| `pins <channel>` | List pinned messages in a channel |
| `thread <channel> --thread "name"` | Create a thread |
| `dm <user> "message"` | Send a direct message to a user |
| `dm-messages <user>` | Read DM history with a user |

### Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON response |
| `--title "text"` | Set embed title |
| `--color <hex>` | Set embed color (default: #1E88E5 blue) |
| `--footer "text"` | Set embed footer text |
| `--url "link"` | Add a URL to the embed title |
| `--limit, -n <N>` | Limit results (users: default 100, messages: default 20) |
| `--field "Name\|Value\|inline"` | Add field to rich embed (repeatable) |
| `--thumbnail "url"` | Add thumbnail image to embed |
| `--image "url"` | Add large image to embed |
| `--thread "name"` | Thread name (for thread command) |

## Examples

### Send Messages

```bash
# Send to channel by name
node .claude/skills/discord/query.mjs send dev-general "Deployment complete!"

# Send to channel by ID
node .claude/skills/discord/query.mjs send 966054537880289330 "Build passed"
```

### Send Announcements

```bash
# Basic announcement with auto-formatting
node .claude/skills/discord/query.mjs announce dev-alerts "New feature deployed!"

# Announcement with custom title and color
node .claude/skills/discord/query.mjs announce deployments "v5.0.1381 released" --title "Release" --color "#00C853"
```

### Rich Embeds with Fields

```bash
# Structured release announcement
node .claude/skills/discord/query.mjs rich-embed dev-general "New release is live!" \
  --title "Release v5.0.1382" \
  --field "Version|5.0.1382|inline" \
  --field "Author|@justin|inline" \
  --field "Changes|3 files modified" \
  --footer "Civitai" \
  --color "#00C853"
```

### Edit Messages

```bash
# Edit using message link
node .claude/skills/discord/query.mjs edit "https://discord.com/channels/955.../966.../123..." "Updated content"

# Edit using channel + message ID
node .claude/skills/discord/query.mjs edit dev-general 1234567890 "Updated content"
```

### Delete Messages

```bash
# Delete using message link
node .claude/skills/discord/query.mjs delete "https://discord.com/channels/955.../966.../123..."

# Delete using channel + message ID
node .claude/skills/discord/query.mjs delete dev-general 1234567890
```

### Reply to Messages

```bash
# Reply using message link
node .claude/skills/discord/query.mjs reply "https://discord.com/channels/955.../966.../123..." "Thanks for the update!"

# Reply using channel + message ID
node .claude/skills/discord/query.mjs reply dev-general 1234567890 "Got it!"
```

### Reactions

```bash
# Add a reaction (use Unicode emoji)
node .claude/skills/discord/query.mjs react "https://discord.com/channels/..." "U+2705"
node .claude/skills/discord/query.mjs react dev-general 1234567890 "U+1F44D"

# Remove a reaction
node .claude/skills/discord/query.mjs unreact "https://discord.com/channels/..." "U+2705"
```

### Pin/Unpin Messages

```bash
# Pin a message
node .claude/skills/discord/query.mjs pin "https://discord.com/channels/..."

# Unpin a message
node .claude/skills/discord/query.mjs unpin "https://discord.com/channels/..."

# List pinned messages
node .claude/skills/discord/query.mjs pins dev-general
```

### Threads

```bash
# Create thread from a message
node .claude/skills/discord/query.mjs thread "https://discord.com/channels/..." --thread "Discussion"

# Create thread in channel (no parent message)
node .claude/skills/discord/query.mjs thread dev-general --thread "New Topic"
```

### Direct Messages

```bash
# Send DM to a user by name
node .claude/skills/discord/query.mjs dm justin "Hey, can you review this PR?"

# Send DM to a user by ID
node .claude/skills/discord/query.mjs dm 303445765865603073 "Quick question about the deployment"

# Read DM history with a user
node .claude/skills/discord/query.mjs dm-messages justin

# Read last 50 DMs
node .claude/skills/discord/query.mjs dm-messages justin --limit 50
```

### Users and Roles

```bash
# List users
node .claude/skills/discord/query.mjs users --limit 50

# Find user to get mention format
node .claude/skills/discord/query.mjs user justin
# Output: Mention: <@303445765865603073>

# List roles
node .claude/skills/discord/query.mjs roles

# Find role to get mention format
node .claude/skills/discord/query.mjs role devs
# Output: Mention: <@&955572624992382996>
```

### Mention Users and Roles

```bash
# Mention a user in a message
node .claude/skills/discord/query.mjs send dev-general "<@303445765865603073> check this PR"

# Mention a role
node .claude/skills/discord/query.mjs announce dev-general "<@&955572624992382996> new release!" --title "Attention Devs"
```

### Read Messages

```bash
# Get last 20 messages (default)
node .claude/skills/discord/query.mjs messages dev-general

# Get last 50 messages
node .claude/skills/discord/query.mjs messages dev-general --limit 50
```

## Message Links

Most commands accept Discord message links directly:
- Format: `https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID`
- Right-click any message in Discord > "Copy Message Link"

Commands that accept message links: `edit`, `delete`, `reply`, `react`, `unreact`, `pin`, `unpin`, `thread`

## Channel Name Matching

Channel names are matched flexibly:
- Exact match: `dev-general`
- Partial match: `dev-gen` matches `dev-general`
- With or without emoji prefix: `team` matches `team`
- Case insensitive: `DEV-GENERAL` matches `dev-general`

## When to Use

- **Deployments**: Announce releases to `deployments` or `dev-alerts`
- **Bug fixes**: Share fixes with the team in `dev-general`
- **Feature announcements**: Post to relevant channels
- **Team updates**: Share progress in `team` or project-specific channels
- **Automated notifications**: Post from CI/CD or scripts
- **Mentioning users**: Look up user IDs with `user` command, then @mention them
- **Mentioning roles**: Look up role IDs with `role` command, then @mention them
- **Reading context**: Check recent messages with `messages` command
- **Reactions**: Acknowledge messages with emoji reactions
- **Organizing discussions**: Create threads for focused conversations
- **Direct messages**: Send private DMs to team members, read DM history

## Tips

- Use `announce` for important updates (creates rich embed)
- Use `send` for quick messages or automated notifications
- Use `rich-embed` for structured data with multiple fields
- Channel names are cached after first lookup
- Bot must have appropriate permissions in target channel
- Use `--json` for scripting or piping to other tools
- Message links work across all message-targeting commands

## Permissions Required

The bot needs these Discord permissions:
- `View Channels` - to list and find channels
- `Send Messages` - to post messages
- `Embed Links` - for rich announcements
- `Read Message History` - to read channel messages
- `Add Reactions` - to add reactions
- `Manage Messages` - to pin/unpin and delete messages
- `Create Public Threads` - to create threads
- Server Members Intent - enabled in Discord Developer Portal (for listing members)

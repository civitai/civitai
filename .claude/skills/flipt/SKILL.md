---
name: flipt
description: Manage Flipt feature flags - list, create, enable/disable, and configure rollout rules. Use when you need to control feature flag state or set up segmented rollouts.
---

# Flipt Feature Flag Management

Use this skill to manage Flipt feature flags for controlled feature rollouts.

## Running Commands

Use the included script:

```bash
node .claude/skills/flipt/flipt.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `list` | List all flags |
| `get <key>` | Get details for a specific flag |
| `create <key>` | Create a new boolean flag |
| `enable <key>` | Enable a flag (set to true) |
| `disable <key>` | Disable a flag (set to false) |
| `delete <key>` | Delete a flag (requires confirmation) |

### Options

| Flag | Description |
|------|-------------|
| `--description <text>`, `-d` | Description for new flag |
| `--enabled` | Create flag as enabled (default: disabled) |
| `--json` | Output results as JSON |
| `--quiet`, `-q` | Minimal output |
| `--force`, `-f` | Skip confirmation prompts |

### Examples

```bash
# List all flags
node .claude/skills/flipt/flipt.mjs list

# Get a specific flag
node .claude/skills/flipt/flipt.mjs get gift-card-vendor-waifu-way

# Create a new flag (disabled by default)
node .claude/skills/flipt/flipt.mjs create my-new-feature -d "Enable new feature for testing"

# Create a flag that's enabled immediately
node .claude/skills/flipt/flipt.mjs create my-feature --enabled -d "Already enabled feature"

# Enable a flag
node .claude/skills/flipt/flipt.mjs enable my-new-feature

# Disable a flag
node .claude/skills/flipt/flipt.mjs disable my-new-feature

# Delete a flag (with confirmation)
node .claude/skills/flipt/flipt.mjs delete old-flag

# Delete without confirmation
node .claude/skills/flipt/flipt.mjs delete old-flag --force

# JSON output for scripting
node .claude/skills/flipt/flipt.mjs list --json
```

## GitOps Integration

Flipt uses GitOps - flags are stored in the `civitai/flipt-state` repository. Changes made via the API are temporary and will be overwritten on the next Git sync (every 30 seconds).

For **permanent changes**, edit the repository directly:

```bash
# Clone the state repo
gh repo clone civitai/flipt-state /tmp/flipt-state

# Edit civitai-app/default/features.yaml
# Add your flag under the `flags:` section

# Commit and push
cd /tmp/flipt-state
git add -A && git commit -m "Add new feature flag" && git push
```

### Flag Format in YAML

```yaml
flags:
  - key: my-feature-flag
    name: my-feature-flag
    type: BOOLEAN_FLAG_TYPE
    description: Description of what this flag controls
    enabled: false
    # Optional: rollout rules
    rollouts:
      - threshold:
          percentage: 50
          value: true
      - segment:
          keys:
            - moderators
          operator: OR_SEGMENT_OPERATOR
          value: true
```

## Safety Notes

1. **API changes are temporary**: The Git repo is the source of truth
2. **Test before enabling**: Use segments for gradual rollout
3. **Coordinate with team**: Others may be editing the same flags

## Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
cp .claude/skills/flipt/.env.example .claude/skills/flipt/.env
```

The skill needs `FLIPT_URL` and `FLIPT_API_TOKEN` to connect to Flipt.

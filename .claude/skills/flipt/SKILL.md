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
| `create` / `enable` / `disable` / `delete` | Refuse with exit 2 and print the GitOps steps — see below |
| `add-variant` / `remove-variant` / `set-rollout` | Same |

**Reads work over the API; writes are deliberately refused.** This Flipt is
**v2** (v2.10.0), GitOps-backed by `civitai/flipt-state` (`poll_interval: 30s`,
so merge → visible takes up to ~30s).

Writes are blocked by choice, not by capability. There is **no Flipt auth at
all** — the `Authorization: Bearer` value in `.env` is a Traefik ingress bypass
header, not a Flipt credential, and Flipt applies no authz behind it. The pod
holds an SSH deploy key for `flipt-state`, and v2's git-write model implies a
write would **commit and push to `main` directly** — inferred from the manifest,
not observed. A write path that *may* bypass review on a file gating production
is reason enough to refuse either way, which is why this skill does. Change flags
by PR to `civitai/flipt-state`.

Treat that bearer value as a real secret: read it from env, never inline it, and
don't copy it into anything new.

Flags live at `/api/v2/environments/{env}/namespaces/{ns}/resources/flipt.core.Flag`.
The environment (`civitai-app`) and namespace (`default`) are discovered at
runtime — the environment marked `default: true`, then its `default` namespace —
so a second environment can't silently redirect reads. Override with
`FLIPT_ENVIRONMENT` / `FLIPT_NAMESPACE` if ever needed.

Responses carry a `revision` equal to the `flipt-state` commit SHA, which is the
quickest way to confirm a flag change has actually synced:

```bash
node .claude/skills/flipt/flipt.mjs list --json | head -3   # revision == your commit
```

### Options

| Flag | Description |
|------|-------------|
| `--description <text>`, `-d` | Description for new flag |
| `--enabled` | Create flag as enabled (default: disabled) |
| `--variant` | Create as variant flag (default: boolean) |
| `--variants <keys>` | Comma-separated variant keys (first is default) |
| `--default <key>` | Set default variant key |
| `--rollout <pct>` | Rollout percentage (default: 100) |
| `--segment <key>` | Segment key for rules (default: all-users) |
| `--json` | Output results as JSON |
| `--quiet`, `-q` | Minimal output |
| `--force`, `-f` | Skip confirmation prompts |

### Examples

```bash
# List all flags
node .claude/skills/flipt/flipt.mjs list

# Get a specific flag
node .claude/skills/flipt/flipt.mjs get gift-card-vendor-waifu-way

# Creating / toggling a flag goes through GitOps — see below.
# These commands exit 2 and print the steps:
node .claude/skills/flipt/flipt.mjs disable my-feature

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

1. **Do not write through the API**: it pushes an unreviewed commit to `flipt-state` main
2. **Test before enabling**: Use segments for gradual rollout
3. **Coordinate with team**: Others may be editing the same flags

## Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
cp .claude/skills/flipt/.env.example .claude/skills/flipt/.env
```

The skill needs `FLIPT_URL` and `FLIPT_API_TOKEN` to connect to Flipt.

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
**v2**, GitOps-backed by a private state repo, so a merged change becomes visible
within about a poll interval.

**Never write through the API.** Flag state is reviewed material — change flags by
opening a PR against the state repo, never by calling the API. This skill refuses
writes for that reason.

## What a key does to the app

The monolith's flag registry (`src/server/services/feature-flags.service.ts`) declares a
static `availability` per flag, and Flipt overrides it in both directions — **except on a flag
whose `FEATURE_FLAG_<KEY>` environment variable was APPLIED**, which is removed from Flipt's
control entirely (`createFeatureFlags` records it in `envOverriddenFlags`; `hasFeature` then
skips Flipt for it).

Whether a variable is applied has exactly one rule, and it is not "is the variable set":

| Registry entry | Its `FEATURE_FLAG_<KEY>` variable | Flipt |
| --- | --- | --- |
| `availability: []` **with** a `fliptKey` | **ignored** — cannot switch it on | **keeps control** |
| anything else | **applied** | **skipped entirely** |

🔴 **So a NON-dark flag can carry a `fliptKey`, have that key set `enabled: false`, and still be
on for everyone.** Toggling it in flag state changes nothing and looks like Flipt is broken.
Before you read such a flag's Flipt value as its effective state — or set one expecting an effect
— check whether a variable names it in the environment you care about.

🔴 **Do not invert that check on a dark flag.** A variable naming an `availability: []` flag that
has a key is discarded, so the flag is dark, off, and still Flipt-owned — the opposite of pinned
out. The server logs a `[feature-flags]` warning naming each one it discards at startup.

Consequences before you add or toggle a key:

- A flag declared `availability: []` **that has a `fliptKey`** is **dark**: static evaluation is
  false for everyone and that key is its only on-switch. A `FEATURE_FLAG_<KEY>` environment
  variable cannot lift it. Creating the key and enabling it is what ships the feature.
- A flag declared `availability: []` with **no** `fliptKey` has no Flipt switch at all, so its
  `FEATURE_FLAG_<KEY>` variable still applies and is the only way to turn it on. Today that is
  `coinbasePayments` and `nowpaymentPayments`, both written in the legacy array form
  (`coinbasePayments: []`), which a search for `availability: []` does not find. Adding a
  `fliptKey` to one of these moves ownership to Flipt and makes its variable inert.
- A flag declared `['public']` (or any role) is **live**: creating its key with
  `enabled: false` and no rollout turns the feature off for everyone — the intended kill switch,
  and the intended accident. **Only if no `FEATURE_FLAG_<KEY>` variable names it.** If one does,
  that kill switch is inert and nothing reports it.

To switch on a dark flag **that has a `fliptKey`** locally, set
`FLIPT_LOCAL_OVERRIDES=<fliptKey>=on` rather than touching shared flag state; it is ignored when
`NODE_ENV=production`, and it does not reach `getFliptBoolean` call sites. For a dark flag with
no key there is nothing to name here — use its `FEATURE_FLAG_<KEY>` variable.

Treat `FLIPT_API_TOKEN` as a live secret: read it from env, never inline it, and
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

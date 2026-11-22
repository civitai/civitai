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

| Command                                                                                       | Description                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list`                                                                                        | List flag DEFINITIONS from flipt-state git                                  |
| `get <key>`                                                                                   | One flag's DEFINITION from git (not found = absent from git)                |
| `get <key> --live`                                                                            | Refuses and names the supported path (below) unless `FLIPT_LIVE_URL` is set |
| `create` / `enable` / `disable` / `delete` / `add-variant` / `remove-variant` / `set-rollout` | Refuse with exit 2 and print the GitOps steps                               |

**`list` and `get` read the DEFINITION in git, not live state.** They read
`civitai-app/default/features.yaml` in `civitai/flipt-state` (private) through `gh api`, or from a
local clone when `FLIPT_STATE_DIR` is set, and print the commit read. The live Flipt loads that
file, so they agree except for the sync interval; they say nothing about `FLIPT_LOCAL_OVERRIDES` or
`FEATURE_FLAG_*` overrides below.

**Live state is not readable from this skill.** The public Flipt host answers every path with a
GitHub OAuth login on purpose (since 11-02), so no token reaches it. The old behavior, "Flag not
found" and HTML from `list`, was this skill parsing that login page. For a live value, ask the
DevOps seat for a gated in-cluster read (or an infra owner). `--live` refuses with that message;
only an explicit `FLIPT_LIVE_URL` (an endpoint DevOps hands you) is ever called, and an HTML or
redirect answer from it is reported as "OAuth/HTML answer", never as a missing flag. Never try
tokens, bypasses or other URLs against the public host.

**Writes are refused.** Flag state is reviewed material: change flags by opening a PR against
the state repo.

Tests: `node --test .claude/skills/flipt/flipt.test.mjs`.

## What a key does to the app

The monolith's flag registry (`src/server/services/feature-flags.service.ts`) declares a
static `availability` per flag, and Flipt overrides it in both directions — **except on a flag
whose `FEATURE_FLAG_<KEY>` environment variable was APPLIED**, which is removed from Flipt's
control entirely (`createFeatureFlags` records it in `envOverriddenFlags`; `hasFeature` then
skips Flipt for it).

Whether a variable is applied has exactly one rule, and it is not "is the variable set":

| Registry entry                           | Its `FEATURE_FLAG_<KEY>` variable | Flipt                |
| ---------------------------------------- | --------------------------------- | -------------------- |
| `availability: []` **with** a `fliptKey` | **ignored** — cannot switch it on | **keeps control**    |
| anything else                            | **applied**                       | **skipped entirely** |

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

### Examples

```bash
node .claude/skills/flipt/flipt.mjs list -q
node .claude/skills/flipt/flipt.mjs get feed-service-primary
node .claude/skills/flipt/flipt.mjs get feed-service-primary --live   # refuses, names the path
node .claude/skills/flipt/flipt.mjs list --json
```

Options: `--json`, `--quiet`/`-q`, `--live`.

## GitOps Integration

Flags are stored in the `civitai/flipt-state` repository and synced to Flipt. For **changes**,
open a PR:

```bash
gh repo clone civitai/flipt-state <scratch-dir>
# edit civitai-app/default/features.yaml under `flags:`, then branch, commit, push, PR
```

### Flag Format in YAML

```yaml
flags:
  - key: my-feature-flag
    name: my-feature-flag
    type: BOOLEAN_FLAG_TYPE
    description: Description of what this flag controls
    enabled: false
    rollouts:
      - segment:
          keys:
            - moderators
          operator: OR_SEGMENT_OPERATOR
          value: true
```

## Safety Notes

1. **Reads are definitions**: say so when you report a value; do not call it live
2. **Test before enabling**: use segments for gradual rollout
3. **Coordinate with team**: others may be editing the same flags

## Environment Setup

Reading needs only `gh` logged in with access to `civitai/flipt-state`. No `.env` is required.
`FLIPT_URL` is ignored on purpose. Treat `FLIPT_API_TOKEN` as a live secret; it is used only with `FLIPT_LIVE_URL`.

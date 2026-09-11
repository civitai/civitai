---
name: generator-launch
description: Read-only readiness check for a generator model version (covered, generatable for you, gated) and the post-deploy launch instructions — publish, then remove the gate — filled in with the version's real URLs and commands. Use after a new generator model's deploy lands, or whenever someone asks where a launch stands. Called by onboard-generator-model; usable on its own.
---

# Generator Launch

```bash
node .claude/skills/generator-launch/launch.mjs check  --version <id>
node .claude/skills/generator-launch/launch.mjs launch --version <id>
```

Both commands only read. They use `CIVITAI_API_KEY` from `.claude/skills/mod-actions/.env`, which must belong to a moderator. `check` also reads the database through `postgres-query`.

## `check`

Reports the version's status, whether it's `covered`, whether **you** can generate with it (`canGenerate`), whether it has an `EcosystemCheckpoints` row, and which gate rules hide it or its ecosystem.

Before launch, expect `Draft`, `covered: true`, `canGenerate: true`, a coverage row, and a moderators-only rule.

If `canGenerate` is false because a rule is available to "nobody", `check` says so. That rule hides the version from moderators too.

## `launch`

Prints numbered post-deploy steps with this version's real URLs and commands, and ticks off any that are already done:

1. **Test as a moderator.** If `canGenerate` is false, it says not to publish.
2. **Publish**, with the green **Publish** button in the version panel of `/models/<modelId>?modelVersionId=<id>`. It says whether this publishes the model and the version together (the model is still a Draft) or only the version.
3. **Remove the gate.** It prints one `generation-gate-rules` command for each rule that hides the version or its ecosystem, including rules set by hand.
4. **Confirm as a non-mod.**
5. **Optional follow-ups:** `GenerationBaseModel`, `AuctionBase`, training, the landing page, and `coverage remove` for `ExternalGeneration` versions.

**The order is fixed: publish, then remove the gate.** While the rule is in place, the published version stays hidden from non-mods everywhere, so publishing exposes nothing early. Removing the gate first shows everyone a Draft model they can't generate with.

Give the user the output as it is; it's written for them. **Don't do the steps yourself.** Publishing and removing the gate are the user's decision. Run `launch` again whenever they ask where things stand, because it re-reads the live state.

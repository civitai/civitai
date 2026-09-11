---
name: generation-coverage
description: Add, remove or inspect a model version's "EcosystemCheckpoints" row — the coverage override that makes a version generatable regardless of publish status — and bust the version cache so the generator sees the change. Use to make a Draft official version testable by moderators, or to drop the override after launch. Called by onboard-generator-model; usable on its own.
---

# Generation Coverage

```bash
node .claude/skills/generation-coverage/coverage.mjs <command> [flags]
```

## What the row does

`GenerationCoverage` is a plain view. Its first branch covers any version listed in `"EcosystemCheckpoints"`, and it applies **no status check**. So:

- **A `Draft` version with a row can be generated, but only by moderators and the model's owner.** `getResourceCanGenerate` lets those two through the private check and refuses everyone else. This is how an official version gets tested before it is published.
- **The row overrides everything else.** The version stays covered even after it is unpublished. For an `ExternalGeneration` version, branch 2 covers it once published, so removing the row after launch is what lets a later unpublish remove coverage. So far every row has been kept.

The full coverage rules are in [docs/features/generator-model-onboarding.md](../../../docs/features/generator-model-onboarding.md).

## Commands

| Command | What it does |
| --- | --- |
| `status --version <id>` | Whether the version has a row, and whether `GenerationCoverage` reports it covered. |
| `add --version <id> --name <label> [--writable]` | Inserts the row, then busts the cache. Idempotent. |
| `remove --version <id> [--writable]` | Deletes the row, then busts the cache. |
| `bust --version <id> [--writable]` | Only the cache bust (`modelVersion.bustCache`). |

- **`--name`** is a free-text label with no behaviour attached. Existing rows use the base model's display name, e.g. `Ideogram 4.0`.
- **The cache bust is part of `add` and `remove`.** `resourceDataCache` sits in front of the view with a one-hour TTL. Without the bust, the generator keeps reporting the old coverage for up to an hour.

## Setup and permission

- **Database:** reads and writes go through the `postgres-query` skill (`--prod` by default, plus `--writable` for `add` and `remove`). Its production connection has to be configured.
- **Choosing the database:** pass `--db dev` for the dev database. When `CIVITAI_API_URL` isn't civitai.com or civitai.red, the script refuses to guess which database goes with it.
- **API key:** the cache bust uses `CIVITAI_API_KEY` from `.claude/skills/mod-actions/.env`, and it must belong to a moderator.

Every write is a dry run unless you pass `--writable`. **Ask the user before each `--writable` call.** It writes to the production database.

---
name: onboard-generator-model
description: Take a new model from nothing to mod-testable in the live generator, then hand off for launch. Orchestrates the child skills in order — add-ecosystem, write-model-description, official-model-admin, generation-coverage, generation-gate-rules, add-generation-support, add-prompt-enhancement-guide and generator-launch — and stops at each deploy. Use when onboarding a new generator model, or a new version of an official one.
---

# Onboard Generator Model

This skill only orchestrates. It decides which child skills run, in what order, and where to stop and wait for a deploy. Each child skill owns its own commands, rules and safeguards, so read a child's SKILL.md when you reach its phase.

The reasoning behind the order is in [docs/features/generator-model-onboarding.md](../../../docs/features/generator-model-onboarding.md).

**End state:** a `Draft` version, owned by CivitaiOfficial, that moderators can generate with on the live site and nobody else can see. Then you hand the user the launch instructions. **Nothing in this flow publishes.**

## Child skills

| Phase | Skill | Role |
| --- | --- | --- |
| 1 | `add-ecosystem` | Ecosystem and base-model records in the constants |
| 2 | `write-model-description` | Draft or review the model description |
| 2, 3 | `official-model-admin` | Create the Draft model and version, and write the description once the user approves it |
| 3 | `generation-coverage` | `EcosystemCheckpoints` row, plus a cache bust |
| 4 | `generation-gate-rules` | Hide it from everyone except moderators |
| 5 | `add-generation-support` | Wire it into both generator lanes |
| 6 | `add-prompt-enhancement-guide` | Prompt-enhancement guide for a new ecosystem |
| 7, 8 | `generator-launch` | Readiness check, then the post-deploy instructions |

Supporting skills: `deploy-status` (the deploy stops), `postgres-query` (used by `generation-coverage`), `mod-actions` (the API key every script uses).

## Phase 0 — Classify

Ask for the model name and a reference link, plus the Civitai model URL if the model already exists. Then work out the case:

| Case | Phases | Deploys |
| --- | --- | --- |
| **A.** New ecosystem | 1 → deploy → 2–7 → deploy → 8 | 2 |
| **B.** New base model in an existing ecosystem | 1 → deploy → 2–5, 7 → deploy → 8 | 2 |
| **C.** New model, existing base model | 2–5, 7 → deploy → 8 | 1 |
| **D.** New version of an existing official model | 2–5, 7 → deploy → 8 | 1 |

Then work out the **kind**: `api-only` (the provider runs it, no files) or `hosted-weights` (we run it from files the user uploads). Settle it with the "Versions: API-only or hosted weights" steps in `official-model-admin`: gather the evidence, then have the user confirm. Never guess it.

The kind changes Phase 3. A hosted-weights version adds a stop while the user uploads its files.

Show the user the case, the kind, the phases and where the run will stop, for deploys and for uploads. Get their confirmation before continuing.

## Phases

1. **Base model (A, B).** Run `add-ecosystem`. For B, it adds only the base-model record.
   - Decline its offer to chain `add-generation-support`: generation support needs the version ID, and that doesn't exist yet.
   - Put this in its own PR.
   - **Stop until it is deployed to production.** Check with `deploy-status`. Phase 3 can't create the version until the server knows the base model.

2. **Description (every case).** `write-model-description` drafts a new description, or reviews the live one for a new version (skip this if nothing needs to change). Then `official-model-admin` writes it with `create-model` or `update-description`. **The user approves the exact text before anything is written.** Follow that skill's approval steps; don't shortcut them.

3. **Version and coverage.**
   1. `official-model-admin create-version --kind <kind>`, using the kind from Phase 0.
   2. **Hosted weights only:** give the user the upload link `create-version` prints, and **stop until they say the upload is done**. Then run `official-model-admin files --version <id>` until it reports READY. If it reports NOT READY, pass its reason on to the user.
   3. `generation-coverage add`, labelled with the base model name.

4. **Gate, before the deploy.** `generation-gate-rules add`:
   - case A: with `--ecosystem <key>`;
   - cases B, C and D: with `--version <id>`.

5. **Generation support.** Run `add-generation-support` with the version ID from Phase 3. Both lanes, including its step 5g.

6. **Prompt enhancement (A only, image and video).** Run `add-prompt-enhancement-guide`.

7. **Ship and test.**
   - Run the typecheck and the tests that cover the change (named in `add-generation-support`).
   - Open a PR when the user asks.
   - After the deploy, run `generator-launch check`. Continue only when the version is `Draft`, covered, and `canGenerate: true` for you. Then ask the user to try generating with it on the live site.

8. **Hand off.** Run `generator-launch launch` and give the user its output: publish, then remove the gate. Don't do those steps yourself.

## Rules for the whole run

- **Ask before every `--writable` call.** Each one writes to production.
- **Never continue past a deploy stop on the assumption that the deploy has probably landed.** Check.
- **Never publish.**
- **End the run by listing every production write it made:** models and versions created, descriptions written, coverage rows, and gate-rule changes.

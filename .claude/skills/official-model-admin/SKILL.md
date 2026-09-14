---
name: official-model-admin
description: Create a Draft CivitaiOfficial model and version through the API, work out whether the version is API-only or needs hosted model files (and walk the user through uploading them), update an existing model's description, or transfer a model to CivitaiOfficial. Every description write requires the user's approval of the exact text, enforced by an approval hash. Use when setting up an official model or version for review before publishing, or when an official model's description needs to change. Called by onboard-generator-model; usable on its own.
---

# Official Model Admin

Creates and edits models and versions on the site through the API. **It never publishes.** Everything it creates stays `Draft` until a human publishes it.

```bash
node .claude/skills/official-model-admin/model.mjs <command> [flags]
node .claude/skills/official-model-admin/model.mjs whoami     # API target, your user id, moderator check
```

## Setup

- It uses `CIVITAI_API_KEY` from `.claude/skills/mod-actions/.env`.
- The key must belong to a moderator, and its scopes must cover model writes (or it must be a full-access key).
- `CIVITAI_API_URL` defaults to `https://civitai.com`.
- `evidence` reads the database through `postgres-query`.

Every write is a dry run unless you pass `--writable`. **Ask the user before each `--writable` call.** They write to production.

## Descriptions: the user approves the exact text first

This applies to `create-model` and `update-description`.

1. Draft the HTML, usually with the `write-model-description` skill, and save it to a scratchpad file.
2. Run the command **without** `--writable`:
   - `create-model` prints the full HTML. Show the user the description itself, rendered as readable text, not a summary of it.
   - `update-description` prints a diff against the live description. Show the user that diff, and the full new text if the diff is large.
3. The dry run ends with an **approval hash**. Ask the user to approve the text **exactly as shown**. If they ask for edits, change the file and run the dry run again, which produces a new hash, then ask again.
4. Once they've approved, re-run with `--writable --approved <hash>`.

The script refuses a hash that doesn't match the current file. For an update, it also refuses if the live description has changed since the dry run. So nothing gets written that the user didn't see.

## Versions: API-only or hosted weights

Every version is one of two kinds, and **the kind has to be settled before `create-version`**:

| Kind | Who runs the model | Files | `usageControl` | Examples |
| --- | --- | --- | --- | --- |
| `api-only` | the provider, behind its API | none; the upload wizard skips the files step | `ExternalGeneration` | Seedance, Qwen 3, Muse Image, ChatGPT Images, the MiniMax H3 API version |
| `hosted-weights` | our cluster, from files on the version | required | `Download`, or `Generation` if downloads shouldn't be offered | Ideogram 4.0, LTXV 2.5, Mage Flow, the MiniMax H3 hosted version |

### 1. Gather evidence

```bash
node .claude/skills/official-model-admin/model.mjs evidence --ecosystem <EcosystemRecord.key> --base-model "<BaseModelRecord.name>"
```

It reports two things:
- **The ecosystem's handler engines.**
  - `comfy` or `*-comfy` means hosted weights.
  - Closed-provider engines (`openai`, `google`, `seedance`, `kling`, `fal`, and so on) mean API-only.
  - Model-family engines (`wan`, `ltx2`, `flux2`, `qwen`) run either way, so they settle nothing.
- **How existing CivitaiOfficial versions of that base model are set up.**

Neither is decisive on its own. The base model doesn't settle it, because MiniMax H3 has one version of each kind. Files don't settle it either, because some older `ExternalGeneration` versions have files attached that are never used.

For a **new ecosystem** there is no handler yet. In that case, check `@civitai/orchestration-client`:
- a `Comfy*` input type means hosted weights;
- a provider-specific input with a provider engine means API-only.

### 2. Decide with the user

Show the user the evidence and your recommendation, then ask the deciding question:

> Does the provider publish weights that we download and run (e.g. on Hugging Face), or is the model only reachable through the provider's own API?

**Never pick the kind silently**, and never pick it from the engine name alone. For hosted weights, also ask whether downloads should be offered. If not, pass `--no-download`, which gives `Generation`.

### 3. Create the version

```bash
node .claude/skills/official-model-admin/model.mjs create-version --model-id <id> --name "<Version name>" \
  --base-model "<BaseModelRecord.name>" --kind <api-only|hosted-weights> [--no-download] --writable
```

- `--base-model` is the base model's **name** (`BaseModelRecord.name`, which is what `ModelVersion.baseModel` stores), not the ecosystem key.
- `Unknown base model: <name>` means the constants that add the base model aren't deployed on the server the API is running on. Deploy them first.

### 4. Hosted weights only: get the files uploaded

`create-version` prints the upload link, `/models/<modelId>/model-versions/<versionId>/wizard?step=2`. This is the one step that can't be scripted.

**Give the user that link and ask them to upload the model files there.** They can also use the model page: the version menu → **Manage files**. Tell them what the files need:

- **At least one weight file** with type `Model`, `Pruned Model`, `Diffusion Model`, `UNet`, `Negative` or `VAE`. Supporting files such as text encoders can also be uploaded.
- **`SafeTensor` format** for a checkpoint.

Then wait. When they say the upload is done, run:

```bash
node .claude/skills/official-model-admin/model.mjs files --version <id>
```

This lists each file with its type, format and scan state. It ends with one of:
- **READY**
- **NOT READY**, with the reason: no files, no weight-type file, still scanning, or no SafeTensor.

If it isn't ready, tell the user what to fix, or when to check again for scanning, and run it again. **Don't move on to coverage until it says READY.** A covered version with no loadable weights fails for mods at generation time, and looks like a code bug.

### 5. Next

A new version can't be generated until it has coverage. Add that with the `generation-coverage` skill.

## Other commands

- **`create-model --name <n> --description-file <html> [--type Checkpoint]`** creates a `Draft` model owned by you, because `model.upsert` always makes the caller the owner. It then transfers it to CivitaiOfficial (`--owner-id` overrides the target). If the transfer fails, the model still exists under your account, and the script prints a `transfer` command to retry with.
- **`update-description --model-id <id> --description-file <html>`** sends the model's current `name`, `type`, `uploadType` and `status` together with the new description.
  - On an update, `model.upsert` ignores `status` and leaves every optional field it isn't sent untouched, so tags, licensing and NSFW settings survive.
  - It reads the description back afterwards, and warns if the server's sanitizing or blurb expansion changed it.
  - A description identical to the live one is a no-op.
- **`transfer --model-id <id>`** transfers the model to CivitaiOfficial. It's the retry path for a failed `create-model`.

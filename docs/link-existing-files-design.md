# Dedupe Model Resources / Link Existing Files

_ClickUp epic [868k69041](https://app.clickup.com/t/868k69041)._

Stop storing the same model file twice by **linking** to a canonical copy instead of re-uploading it.
The epic has three subtasks:

| Subtask | Status | What it does |
|---|---|---|
| **A** — Link the ecosystem resources ([868k690c2](https://app.clickup.com/t/868k690c2)) | ✅ shipped | Link the official standalone VAE/encoder/etc. into the live ecosystem checkpoints, and let creators link official/own published component models at upload time. |
| **B** — Link to official instead of upload if hash matches ([868k6917j](https://app.clickup.com/t/868k6917j)) | ✅ shipped | When a file's bytes already exist on the official account, link to the official copy instead of storing a duplicate. |
| **C** — Auto-link diffusion models to ecosystem required resources ([868k692vz](https://app.clickup.com/t/868k692vz)) | ⏳ remaining | Suggest an ecosystem's required components (VAE/CLIP/…) on a model, with the ability to toggle them off or override with a custom upload. |

## How linking works

A model version can reference a **canonical file that lives on another version** instead of storing its
own copy — a **linked component**:

- The pointer records which canonical file it links to. On read, the source file's data (name, size,
  type) is hydrated so the component displays normally; on download, the **canonical bytes** are served.
- Files are identified by their **full-file SHA256** (byte identity). Two uploads of the same file have
  the same hash, so a duplicate can be detected and pointed at one shared copy instead of stored twice.
- **Self-healing:** if the canonical source file is ever deleted, the dependent components are dropped
  from reads and skipped on download — they disappear rather than 404.

Reclaiming space is simply: create the pointer to the canonical file, then delete the redundant copy
(its storage is freed by the normal url-refcount GC). Nothing is merged — one row points at another's
file.

Only **accessory/component** files are ever linked/deduped (VAE, text encoder, CLIP, ControlNet, …) —
never a model's primary weights.

## Subtask A — Link the ecosystem resources (shipped)

The official account uploads canonical standalone resources (a VAE, a text encoder, …); A links those
into the already-live ecosystem checkpoints as linked components and removes the redundant bundled
copies. At upload time a creator can also link a canonical resource through the picker's **Official**
and **Mine** tabs (the official / their own published component models), which relax base-model
matching so, for example, a Flux VAE can be linked into a Boogu checkpoint. A one-off backfill
collapsed the pre-existing official duplicates.

## Subtask B — Link to official instead of upload if hash matches (shipped)

When a user adds a component file whose bytes already exist on the official account:

- **Prevent the upload (client):** before the bytes are sent, the file is hashed and matched against
  the official account; on a match the upload is skipped and a linked component to the official file is
  created instead.
- **Safety net (server):** if a matching file does get uploaded, it is converted to a pointer and its
  copy deleted after the scan.
- **Reclaim job:** an hourly job rehomes existing non-official duplicates of an official file onto it.

The match is on bytes, not on the file's declared type — so a file dropped in the main file section (or
mislabelled) is checked too and can't be used to bypass dedup; a genuine checkpoint match links nothing.

## Subtask C — Auto-link diffusion models to ecosystem required resources (remaining)

Today nothing pins an ecosystem's required accessory resources (VAE/CLIP/encoder) — only a default
checkpoint exists per ecosystem. C adds that:

- **C.1 — the data.** A required-resources map per ecosystem/base model (`componentType → the canonical
  resource`). Open question: keep it in **constants** (versioned, no migration — recommended) or a
  small **DB table** (changeable without a deploy).
- **C.2 — file edit page.** Surface the ecosystem's required resources as suggested linked components on
  a model, each with a show/hide toggle; if the user uploads a custom component of the same type, hide
  the suggestion for that type (the upload overrides it).
- **C.3 — model details.** Show the ecosystem required resources to viewers alongside the model's
  explicit required components. Open question: **materialize** them as real pointer rows (consistent,
  but stale if the map changes) vs **compute at read** (always fresh — recommended), with a
  user-uploaded component of the same type taking precedence.

## Non-goals

- No content-addressed / blob storage — delete + repoint is enough.
- No merging two storage urls onto one object; the duplicate row is deleted, not merged.
- No cross-user linking of arbitrary private files — dedup is scoped to the caller's own published
  models (A) or the official account (B).

# Model File Linking & Deduplication

Stop storing the same model file twice by **linking** to a canonical copy instead of
re-uploading it. Only **accessory/component** files are ever linked (VAE, text encoder, CLIP,
ControlNet, …) — a model's **primary weights are never linked or deleted** (`primaryModelFileTypes`
in `~/utils/file-display-helpers`).

## How a linked component works

A model version can reference a **canonical file that lives on another version** instead of storing
its own copy — a **linked component** (a `RecommendedResource` with `settings.isLinkedComponent`):

- **Read:** the source file's data (name, size, type) is hydrated so the component displays
  normally. **Download:** the **canonical bytes** are served.
- **File identity is the full-file SHA256** (`ModelFileHash`, type `SHA256`, uppercase hex). Two
  uploads of the same bytes share a hash, so a duplicate is detected regardless of how the file was
  labelled — a mislabelled or main-section drop is matched too and can't bypass dedup. A genuine
  primary-weights match links nothing (its component type resolves to null).
- **Self-healing:** if the canonical source file is deleted, dependent components are dropped from
  reads and skipped on download — they disappear rather than 404.

Reclaiming space = create the pointer, then quarantine/delete the redundant copy (its S3 bytes are
freed by the url-refcount GC). Nothing is merged; one row points at another's file.

## How files get linked

**Ecosystem resources.** The official account holds canonical standalone resources (a VAE, a text
encoder, …), which are linked into the ecosystem checkpoints as components while the redundant
bundled copies are removed. At upload time a creator can also link a canonical through the picker's
**Official** / **Mine** tabs (the official account's or their own published component models); these
tabs relax base-model matching so, e.g., a Flux VAE can go into a Boogu checkpoint.

**Link-on-hash instead of upload.** When a component file's bytes already exist on the official
account:
- **Client** hashes before sending; on a match the upload is skipped and a linked component created.
- **Server safety net** converts a matching file that did get uploaded into a pointer after the scan.
- **Hourly reclaim job** rehomes existing non-official duplicates of an official file onto it.

**Quarantine of replaced files.** A replaced copy is **not hard-deleted** — it is flagged
`ModelFile.replacedAt` + `visibility=Private` (bytes retained, hidden from reads and public
download). A **daily job purges** the S3 object after 30 days (refcount-guarded) and keeps the row
with `dataPurged=true` as an audit trail. A **moderator-only restore** endpoint un-flags a file
during the window — a recovery window instead of irreversible deletion.

## Non-goals

- No content-addressed / blob storage — delete + repoint is enough.
- No merging two storage urls; the duplicate row is deleted/quarantined, not merged.
- No cross-user linking of arbitrary private files — scoped to the caller's own published models
  or the official account. Linking must only target **published, moderated** sources: the
  linked-component download gates on the **host** model's status, so linking a draft/unscanned source
  into a published host would be a moderation bypass.

## Key code

| Concern | Location |
|---|---|
| Create/replace a linked component | `addLinkedComponent` in `server/services/model-version.service.ts` |
| Hash match → official file + component type | `findOfficialFileByHash` in `server/services/model-file.service.ts` |
| Link-on-hash server path | `linkOfficialFileByHash` in `server/services/model-version.service.ts` |
| Quarantine flag + active-file filter | `markFileReplaced`, `activeModelFileWhere` in `server/services/model-file.service.ts` |
| Reclaim job | `server/jobs/dedupe-official-uploads.ts` |
| 30-day purge job | `server/jobs/purge-replaced-files.ts` |
| `replacedAt` column | migration `20260703120000_add_modelfile_replacedat` (applied manually) |

# Importing models from Hugging Face

**Status:** built, not deployed. The migration has not been applied to any database.

## The goal

Give a moderator a Hugging Face repo URL and have *our* servers fetch the weights into our storage —
instead of a person downloading 20 GB and re-uploading it through the browser wizard. That upload was the one
part of `official-model-admin` the skill had to hand back to a human; step 4 of that skill now offers
this as the first route.

## What was built

| Piece | Where |
| --- | --- |
| `HuggingFaceImport` table + status enum | `packages/civitai-db-schema/prisma/schema.full.prisma`, migration `20260914120000_huggingface_import` |
| HF API client — parse a URL, resolve a branch to a commit sha, list files with sizes and LFS sha256, ranged reads | `src/server/services/huggingface.service.ts` |
| Queue + the resumable transfer | `src/server/services/huggingface-import.service.ts` |
| The runner | `src/server/jobs/process-huggingface-imports.ts`, registered in the `jobs` array in `run-jobs` |
| tRPC surface (`getAll` — filterable by `groupName`/`repo`, and by `unattached` — `getCounts`, `lookup`, `enqueue`, `attach`, `detach`, `delete`, `renameGroup`, `retry`, `cancel`) | `src/server/routers/huggingface-import.router.ts` |
| Moderator page | `src/pages/moderator/huggingface-import.tsx` + `src/components/Moderation/HuggingFaceImport/` |
| The *Manage files* picker (moderator-only) | `src/components/Moderation/HuggingFaceImport/AddFromImportsModal.tsx`, opened via `src/components/Dialog/triggers/add-from-hugging-face-imports.ts` from `AddFromImportsButton.tsx` in `src/components/Resource/Files.tsx` |
| Server-side multipart helpers (`createMultipartUpload`, `uploadPart`) | `src/utils/s3-utils.ts` |
| The shared key builder (`buildUploadKey`) | `src/utils/upload-key.ts` — used by `/api/upload` **and** the import |

Config: `HUGGING_FACE_TOKEN` is **optional**. Without it, public ungated repos import fine; with it,
repos whose terms that token's account has accepted.

## Why a resumable transfer, and why a cron job

A 20 GB transfer cannot live inside one request or one job run — jobs here hold a Redis lock sized in
minutes (5 typical, 30 at the longest), and a pod rolls on every deploy. So the transfer is a sequence
of **independent parts**:

- HF's CDN honours HTTP `Range`, so each part is its own request.
- S3/B2 multipart lets a *different process* upload part N, as long as it holds the `uploadId`.

The row stores `uploadId`, `partSize` and the `parts` written so far. Each job run moves as many parts as fit in
its budget (2 minutes under a 5-minute lock, leaving room for the slowest part still in flight) and
stops; the next run continues the same file.
A deploy costs one part, not the file. `advanceImport` re-reads the row's status between parts, so a
cancel takes effect within one part rather than at the end.

Claiming is `FOR UPDATE SKIP LOCKED`. A run that yields cleanly clears its claim, so the row is
eligible on the very next tick; a run that *dies* leaves its claim, and the 20-minute stale window is
what recovers it. That asymmetry is deliberate — it is what tells "out of budget" from "the pod went
away."

## Attaching to a version

`attach` turns a finished import into a `ModelFile` on a version, going through `createFileHandler`
rather than writing the row directly — that is what gets the storage-resolver registration and the
inline scan submission, so scanning and hashing follow on their own.

Four ways in, one path underneath: the Attach control on a completed row, the **Add from Hugging
Face imports** picker inside a version's *Manage files*, the `huggingFaceImport.attach` procedure,
and two commands on `official-model-admin` — `hf-imports` (what transferred) and `attach-import`
(put one on a version).

What that changes for the skill: the 20GB re-upload a person used to perform is gone, and attaching is
scriptable. A human still queues the repo on the page, and still confirms the file type when the
filename does not settle it — `suggestFileType` is returned on both `lookup` and `getAll`, but it is
advisory and refuses to name the primary weights.

🔴 **The file type is explicit, never inferred.** `suggestFileType` offers a guess from the filename
for accessories (VAE, text encoder, config) and deliberately returns null for the primary weights,
because a mislabelled weight file passes every check here and produces a version nothing can load.

## Naming, and what a group is

**An imported object is keyed exactly like a browser upload.** Both paths call the same
`buildUploadKey` and resolve the same backend, so a file transferred from Hugging Face is stored at
`model/<userId>/<name>.<token><ext>` in the bucket `/api/upload` would have used — B2 whenever
`S3_UPLOAD_B2_ENDPOINT` is set — with the same `filenamize` and the same 4-character token. That shape is load-bearing: `/api/upload/sign-part` authorises a part by reading the
userId out of segment 1, so nothing may be inserted ahead of it.

🔴 **Nothing about the import appears in the key** — not the repo, not the revision, not the group.
A key is immutable once the object exists, so anything encoded there could never be corrected without
copying the bytes. **The `HuggingFaceImport` row is the index**: `repo`, `revision`, `filename` and
`groupName` are columns, and columns can be fixed.

**The group** is the batch a moderator filed the import under:

- `repo` is taken from **Hugging Face's own response**, never from the pasted URL — the same repo typed
  with different casing would otherwise be filed under two groups nothing could merge.
- `groupName` defaults to the repo's own name (`black-forest-labs/FLUX.1-Krea-dev` → `FLUX.1-Krea-dev`)
  and is typed on the lookup screen before Import is pressed.
- It can be renamed later, at any status, from the group header on the **Unattached** tab. The name
  never reaches a storage key, so a rename desynchronises nothing. `renameGroup` is scoped by the
  group's current name as well as repo and revision, because one repo at one revision can be two
  batches.

### Finding a group again

`getAll` filters **on the server** — `groupName` as a case-insensitive substring, `repo` as an exact
match on the id Hugging Face returned. Both the page's filter box and the skill's `--group`/`--repo`
pass through to it.

🔴 That is not a convenience. Both callers take at most 100 rows, and filtering those client-side
meant a group older than that window returned nothing — which reads exactly like "never imported".
`@@index([groupName])` serves the equality lookups; the substring search does not use it, and at this
table's size that is a few milliseconds of seq scan. If it ever stops being one, the answer is a
trigram index rather than a narrower filter.

## Throughput

Segmenting is nearly free; doing the segments **serially** was not. Each part is two hops — a ranged
read from HF, a part written to the bucket — and one-at-a-time left both idle half the time, making the
import roughly half the speed of a single stream.

Parts now move concurrently: `PARTS_IN_FLIGHT` (3) per file, two files per run. Parallel range
requests also get more out of Hugging Face than one connection does, which is the same reason
`hf_transfer` exists. **Memory is the ceiling, not the network** —
`PARTS_IN_FLIGHT × file concurrency × partSize` = 3 × 2 × 16 MB ≈ 96 MB resident today. That is the dial.

Because parts finish out of order, the completed set has holes: the resume point is the set of missing
part numbers, never `parts.length + 1`, and `completeMultipartUpload` gets them sorted.

No real-world measurement exists yet — nothing has run against a live bucket.

## What it does not do yet

**Nothing checks that the file you attached is the file you meant.** The scan catches malware, not
mislabelling.

The direction is a **pull**: an import usually happens before anyone knows which version will want
it, so the version draws from the pool rather than the import pushing at a version. Both surfaces
that make that work now exist — the **Unattached** tab on the import page and the **Add from Hugging
Face imports** picker inside a version's *Manage files*, both grouped and filtered by `groupName`.

The only two exits from the unattached list are *attached* and *deleted*: there is deliberately no
dismissed-but-stored state, because a hidden row still costs storage and would let the count
understate what we hold.

🔴 **Deleting refuses whenever a `ModelFile` still points at the object**, resolved through
`urlsSafeToDelete` over `ModelFile.url` — not through the import row's `modelFileId`, which detach
clears while leaving the `ModelFile` alive. Judging from the row alone destroys the bytes a
published version is serving, two clicks after a detach.

**No quota.** Moderator-only at the router; everything underneath is already scoped per owner, so
opening it up needs a per-user quota — size and count — and a `userId` in the
`(repo, revision, filename)` unique index — the header comment in `huggingface-import.router.ts` is
the prerequisite list.

**Licenses are shown, not enforced.** The page surfaces the declared license and flags gated repos.

## What HF gives us before any bytes move

`/api/models/{repo}/tree/{revision}?recursive=true` returns each file's `size` and, for LFS files
(every weight file), `lfs.oid` — **the content sha256**. So the page can mark a file we already store
(`ModelFileHash` lookup) and offer to skip it, and the transfer knows its part count up front. The
commit `sha` is pinned rather than `main`, so a re-import is reproducible and the provenance record
means something.

## The old importer is live, not dead — and it is not a head start

`src/server/importers/huggingFaceModel.ts` creates a `Model` with **no versions**: the loop that
creates `ModelVersion` rows is commented out, `baseModel` is hardcoded to `SD 1.5`, and
`ModelFile.url` points at huggingface.co rather than our storage, so nothing is ever transferred.

It is reachable today. `src/pages/api/import.ts` is a `ModEndpoint` (`GET /api/import?source=…`) and
`processImportsJob` drains the `Import` table hourly, so it is live-but-broken rather than dead. It
also duplicates this segment's HF client — its own regex, its own API fetch, no auth header, and
`main` instead of a pinned commit — which is two HF clients for the next person to fix.

Retiring it (the importers, `/api/import`, and `processImportsJob`) is a separate change; this segment
deliberately does not touch it.

## Open questions

1. **Who may import**, and under what quota — see above.
2. **Whether redistribution rights should be enforced** rather than displayed.
3. ~~**Does deleting an unattached import remove its row, or leave a tombstone?**~~ **Settled: hard
   delete.** `(repo, revision, filename)` is unique, so a tombstone would block re-importing that
   exact file — and a deliberate deletion is precisely the case where you might want it back. The
   cost is losing the record that we once held those bytes.
4. **Attribution.** The row records repo, revision and filename, and an attached file links back to it.
   Nothing surfaces that on the model page yet.

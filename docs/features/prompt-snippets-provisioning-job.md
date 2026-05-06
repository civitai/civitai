# WildcardSet Provisioning Job

**Status:** ready for implementation in a dedicated session
**Owner:** TBD
**Companion docs:**

- [prompt-snippets.md](./prompt-snippets.md) — feature overview
- [prompt-snippets-schema.md](./prompt-snippets-schema.md) — schema spec (authoritative for table definitions)
- [prompt-snippets-schema-examples.md](./prompt-snippets-schema-examples.md) — populated table walkthrough

---

## 1. Purpose

Pre-create `WildcardSet` + `WildcardSetCategory` rows for every published wildcard-type `ModelVersion`, so that:

1. **User imports become pure pointer creation** (instantaneous; no extraction or audit on the user-facing path).
2. **The wildcard catalog is browsable** — category counts, value counts, and previews are available before any user has imported.
3. **Audit runs once per model version** (centrally, off the user path) rather than per-first-importer.
4. **Concurrency is trivial** — the `WildcardSet` always exists by the time anyone tries to import; no first-importer race condition.

This document covers the provisioning job only. The user-facing import flow, the picker UI, the resolver, and other phases are described in the product doc.

## 2. Scope

**In scope:**

- A reusable `importWildcardModelVersion(modelVersionId)` service function that:
  - Locates the wildcard model's source zip
  - Extracts text files
  - Normalizes nested-reference syntax (`__name__` → `#name`)
  - Creates `WildcardSet` + `WildcardSetCategory` rows
  - Enqueues the audit job for the new set
- A publish-time hook that calls this function when a wildcard-type `ModelVersion` is published.
- A periodic reconciliation cron job that catches any `Published` wildcard model versions without a corresponding `WildcardSet`.
- A one-time backfill script for the initial deploy (basically: run reconciliation against all existing published wildcard models).
- Idempotency, error handling, and observability.

**Not in scope (separate work):**

- The audit pipeline itself (`auditPromptEnriched` → `WildcardSetCategory.auditStatus` flips). This job *enqueues* audit but doesn't implement it. The audit-consumer side is described in [prompt-snippets-schema.md](./prompt-snippets-schema.md) §6.3.
- The user-facing "create" flow on wildcard model pages — clicking "create" looks up the existing `WildcardSet.id` and adds it to the form's localStorage `wildcardSetIds`. No DB writes needed on the user path once provisioning has run; see [prompt-snippets-schema.md](./prompt-snippets-schema.md) §6.1.
- Picker UI, resolver, generation form integration.
- Schema migrations — the `WildcardSet` and `WildcardSetCategory` tables must already exist (see schema doc §8 for the migration). This job assumes the schema is in place.

## 3. Architecture

Two complementary paths feed the same core import function:

```
                ┌──────────────────────────────────┐
                │   importWildcardModelVersion()   │
                │   (shared core; idempotent)      │
                └────────────────┬─────────────────┘
                                  │
              ┌───────────────────┴────────────────────┐
              │                                          │
   ┌──────────▼──────────┐                ┌──────────────▼─────────────┐
   │  Publish-time hook  │                │   Reconciliation cron       │
   │  (event-driven,     │                │   (every hour or daily;     │
   │   primary path)     │                │    safety net + backfill)   │
   └──────────┬──────────┘                └──────────────┬──────────────┘
              │                                          │
        Fires when a             Periodically scans for ModelVersions
   wildcard ModelVersion        with status='Published', type='Wildcard',
       is published                and no matching WildcardSet row.
```

Both paths converge on the same `importWildcardModelVersion(modelVersionId)` function. Idempotency is enforced by the `(modelVersionId)` unique constraint on `WildcardSet`.

## 4. Implementation detail

### 4.1 Shared core: `importWildcardModelVersion`

Location: probably `src/server/services/wildcardSetProvisioning.service.ts` (or wherever sibling import services live — investigate during implementation).

```ts
async function importWildcardModelVersion(modelVersionId: number): Promise<{
  status: 'created' | 'already_exists' | 'failed';
  wildcardSetId?: number;
  error?: string;
}> {
  // 1. Check if already imported (fast path for reconciliation re-runs)
  const existing = await prisma.wildcardSet.findUnique({
    where: { modelVersionId },
    select: { id: true }
  });
  if (existing) return { status: 'already_exists', wildcardSetId: existing.id };

  // 2. Load the model version + verify it's a Wildcard type
  const modelVersion = await prisma.modelVersion.findUnique({
    where: { id: modelVersionId },
    include: { model: { select: { type: true, name: true } }, files: true }
  });
  if (!modelVersion || modelVersion.model.type !== 'Wildcard') {
    return { status: 'failed', error: 'not a wildcard model version' };
  }

  // 3. Locate the source zip file URL (usually one .zip per ModelVersion)
  const zipFile = modelVersion.files.find(f => f.name.endsWith('.zip'));
  if (!zipFile) return { status: 'failed', error: 'no zip file' };

  // 4. Download + extract zip → in-memory list of { filename, lines[] }
  let files;
  try {
    files = await extractWildcardZip(zipFile.url);
  } catch (err) {
    return { status: 'failed', error: `extraction failed: ${err.message}` };
  }

  // 5. Normalize: rewrite __name__ → #name in every line
  for (const f of files) {
    f.lines = f.lines.map(normalizeNestedRefs);
  }

  // 6. Create WildcardSet + categories in a single transaction
  const result = await prisma.$transaction(async (tx) => {
    const set = await tx.wildcardSet.create({
      data: {
        kind: 'System',
        modelVersionId,
        modelName: modelVersion.model.name,
        versionName: modelVersion.name,
        sourceFileCount: files.length,
        totalValueCount: files.reduce((n, f) => n + f.lines.length, 0),
        auditStatus: 'Pending',
      }
    });

    for (const [i, f] of files.entries()) {
      await tx.wildcardSetCategory.create({
        data: {
          wildcardSetId: set.id,
          name: f.filename.replace(/\.txt$/, ''),
          values: f.lines,
          valueCount: f.lines.length,
          displayOrder: i,
          auditStatus: 'Pending',
          nsfwLevel: 0,
        }
      });
    }

    return set;
  });

  // 7. Enqueue audit job for the new set (post-commit)
  await enqueueAuditJob({ wildcardSetId: result.id });

  return { status: 'created', wildcardSetId: result.id };
}

function normalizeNestedRefs(line: string): string {
  // Rewrite __name__ → #name. Single-pass regex; no nested escaping needed
  // since the source uses a flat token format.
  return line.replace(/__([a-zA-Z][a-zA-Z0-9_]*)__/g, '#$1');
}
```

**Concurrency:** if two callers race to import the same `modelVersionId`, one wins via the `@unique` constraint; the loser catches the unique-violation error and re-runs the find-existing path. Wrap the create call in a try/catch:

```ts
try {
  const set = await tx.wildcardSet.create({ ... });
  // ... categories
} catch (err) {
  if (err.code === 'P2002' /* Prisma unique violation */) {
    return { status: 'already_exists', wildcardSetId: (await tx.wildcardSet.findUnique({ where: { modelVersionId } }))!.id };
  }
  throw err;
}
```

### 4.2 Publish-time hook

When a wildcard-type `ModelVersion` transitions to `Published`, call `importWildcardModelVersion(modelVersionId)`. Asynchronous (don't block the publish response). Fire-and-forget into the existing job queue is fine — reconciliation will catch any failures.

**Where to hook:**

- The model publish path is somewhere around `src/server/services/model.service.ts` or `src/server/controllers/model.controller.ts`. Investigate during implementation — look for where `ModelVersion.status` is set to `Published`, or where publish-time side effects (notifications, metrics) already fire.
- The job queue framework currently in use should be the implementation target. Look for existing patterns like `enqueue*` calls.

**Suggested implementation:**

```ts
// In the publish flow, after the publish transaction commits:
if (modelVersion.model.type === 'Wildcard') {
  enqueueWildcardSetImport({ modelVersionId: modelVersion.id });
}
```

Where `enqueueWildcardSetImport` queues a job that calls `importWildcardModelVersion(modelVersionId)` with the existing retry/backoff machinery.

### 4.3 Reconciliation cron

Runs periodically (suggested: every hour). Scans for missed/failed imports.

```ts
async function reconcileWildcardSets() {
  const unimported = await prisma.modelVersion.findMany({
    where: {
      model: { type: 'Wildcard' },
      status: 'Published',
      WildcardSet: null,                    // no matching set
    },
    select: { id: true },
    take: 100,                              // batch size; tune as needed
  });

  for (const mv of unimported) {
    const result = await importWildcardModelVersion(mv.id);
    if (result.status === 'failed') {
      logger.warn('wildcard set provisioning failed', { modelVersionId: mv.id, error: result.error });
      // Optional: increment a metric, alert mods after N failures
    }
  }
}
```

**Scheduling:** use the existing cron framework (probably the same one that runs other reconciliation jobs — look for sibling `*Job.ts` files). Hourly is a reasonable default; daily is fine if event-driven publishing is reliable.

**Backoff for repeated failures:** if a `modelVersionId` fails N times in a row (e.g. the zip is corrupt and extraction will never succeed), stop retrying and flag for manual moderator review. Could be tracked via a separate `WildcardSetImportFailure` table or just a counter on a job-state record; implementer's choice.

### 4.4 One-time backfill

For the initial deploy: pre-existing wildcard models need their `WildcardSet`s created. The reconciliation job naturally handles this — it just needs to run repeatedly until all unimported models are processed.

**Recommended approach:**

1. Deploy the migration + provisioning code in a "schema-only" state (no UI yet).
2. Run a manual one-shot script that calls `reconcileWildcardSets()` in a loop until it finds nothing to process. This may take a while if there are many wildcard models on the platform — log progress.
3. Verify counts: `SELECT COUNT(*) FROM "ModelVersion" mv JOIN "Model" m ... WHERE m.type = 'Wildcard' AND mv.status = 'Published'` should equal `SELECT COUNT(*) FROM "WildcardSet" WHERE kind = 'System'`.
4. Audit job picks up the new sets and processes them in the background.

A standalone script at `scripts/backfill-wildcard-sets.ts` (or wherever Civitai keeps one-off scripts) is fine. Keep it idempotent — re-running should be safe.

## 5. Audit pipeline integration

This job's responsibility ends at "row created + audit enqueued." The audit pipeline runs separately and updates `WildcardSetCategory.auditStatus` + `nsfwLevel` per-category, then rolls up to `WildcardSet.auditStatus`.

Until audit completes, the `WildcardSet` exists but its categories are `auditStatus: Pending`. The resolver excludes Pending categories from generation pools (only `Clean` ones contribute), so the set effectively can't be used yet.

If the audit pipeline isn't yet built when this job ships, the rows will sit at Pending until it does. That's acceptable — the user can still load the set into their form's localStorage `wildcardSetIds` via the "create" button on the model page, but the picker will show "this set is still being processed" until the audit lands.

**Contract from this job to the audit job:**
- This job calls `enqueueAuditJob({ wildcardSetId })` after committing.
- The audit job is responsible for processing all `Pending` categories belonging to that set, updating per-category fields, and rolling up the set-level `auditStatus`.
- Audit failures don't roll back this job — a `WildcardSet` with all-Dirty categories is valid (just unusable).

## 6. Edge cases

| Case | Behavior |
|---|---|
| Same `modelVersionId` imported twice (race) | Unique constraint enforces single row; second caller returns `status: 'already_exists'`. |
| Zip file missing or corrupt | Job returns `status: 'failed'`. Reconciliation retries; after N failures flag for mod review. |
| Wildcard model unpublished after import | Don't auto-delete the `WildcardSet`. A separate moderation flow (out of this job's scope) sets `WildcardSet.isInvalidated = true`. The set still exists in the DB; user pointers work but the resolver excludes invalidated sets from pools. |
| Wildcard model deleted (hard) | The schema's `onDelete: Restrict` on `WildcardSet.modelVersion` blocks the delete. Resolution: invalidate the wildcard set first, then delete (admin action). |
| Republish of same `ModelVersion` (uploaded a new zip for the same version) | Out of this job's scope — model versions are immutable post-publish per Civitai's general convention. If this convention ever changes, this job needs to handle re-extraction and audit. Flag the assumption in code comments. |
| Job runs while audit is still processing the previous run's results | Idempotent — `importWildcardModelVersion` returns `'already_exists'` and skips. Audit job runs to completion independently. |
| Empty zip / no `.txt` files | Return `status: 'failed'` with a helpful error. Treat as a publishing problem; flag for mod review. Don't create an empty `WildcardSet`. |
| `.txt` file with all empty/whitespace lines | Skip silently — `lines` for that file is `[]`, no `WildcardSetCategory` is created for it. The `WildcardSet` exists with the other non-empty categories. |
| Source files use unusual character encoding | Default to UTF-8; fail explicitly if decoding errors occur (don't silently mangle text). |

## 7. Testing strategy

**Unit tests:**

- `normalizeNestedRefs`: a handful of cases (single ref, multiple refs, no refs, nested in alternation `{__a__|__b__}`)
- `importWildcardModelVersion`: idempotency (call twice, second returns `already_exists`); failure paths (no zip, corrupt zip, not-a-wildcard-model)

**Integration tests:**

- Full end-to-end against a known wildcard model version in a test DB — verify row counts, normalized values in the `text[]` column, audit job enqueued.
- Reconciliation cron: seed N unimported wildcard model versions, run reconciliation, assert all are imported.

**Manual verification before backfill:**

- Run the import against a single small wildcard model in staging
- Verify the `WildcardSet`, `WildcardSetCategory` rows look correct
- Spot-check a few `values` arrays for proper normalization (`__name__` rewritten to `#name`)
- Verify the audit job is enqueued

## 8. Implementation checklist

In order:

- [ ] **Pre-req:** confirm the schema migration ([prompt-snippets-schema.md](./prompt-snippets-schema.md) §8) has shipped — `WildcardSet`, `WildcardSetCategory` tables + enums + CHECK constraint exist.
- [ ] **Pre-req:** confirm an audit-job target exists (or stub one that no-ops; the audit pipeline itself can ship after this job).
- [ ] Implement `extractWildcardZip(url)` helper — downloads zip from S3/CloudFront, extracts in memory, returns `{ filename, lines: string[] }[]`. Reuse existing zip-extraction utilities if any exist.
- [ ] Implement `normalizeNestedRefs(line)` — single regex rewrite.
- [ ] Implement `importWildcardModelVersion(modelVersionId)` — the shared core function described in §4.1.
- [ ] Wire the publish-time hook (§4.2) into the existing model publish flow.
- [ ] Implement and schedule the reconciliation cron (§4.3).
- [ ] Write the backfill script (§4.4).
- [ ] Tests: unit + integration per §7.
- [ ] Run staging backfill and verify.
- [ ] Run prod backfill (likely a few minutes to an hour depending on wildcard model count).
- [ ] Add observability: count of imports succeeded/failed per run, alert on N consecutive failures.

## 9. Open questions to resolve in the implementation session

These are codebase-specific and need investigation:

1. **Job queue framework.** What does Civitai use for background jobs (Bull? Custom? Tekton tasks)? The publish hook and reconciliation cron should plug into whatever already exists. Look at sibling `*Job.ts` or `src/server/jobs/` for patterns.
2. **Cron scheduler.** Where are scheduled jobs registered? How are they triggered (Vercel cron? GitHub Actions? Internal scheduler)?
3. **Model publish hook point.** Where in `src/server/services/model.service.ts` or controller does `ModelVersion.status` flip to `Published`? Need to add the wildcard-import enqueue here.
4. **Zip extraction utilities.** Does Civitai already have helpers for downloading + extracting zip files from S3/CloudFront? Check `src/utils/` or `src/server/utils/`. If yes, reuse.
5. **`enqueueAuditJob` signature.** Need to coordinate with whoever's building the audit pipeline. The job should accept `{ wildcardSetId }` and process all Pending categories belonging to that set.
6. **Model version files structure.** What's the exact `ModelVersion.files` shape for wildcard models? Likely a single `.zip` entry but worth confirming. Check existing wildcard-model records on the platform.
7. **Failure tracking.** Does the existing job framework provide retry counts and dead-letter queues, or do we need a separate `WildcardSetImportFailure` table?
8. **Where to log + observe.** Probably the existing `logger` + Axiom/Datadog. Add metrics for job success/failure counts + duration.

## 10. Code locations to check

For grounding the implementation work — these are likely paths based on a typical Next.js/Prisma codebase like Civitai's. Confirm during the session:

- **Service layer:** `src/server/services/` — likely the new `wildcardSetProvisioning.service.ts` should live here next to `model.service.ts`
- **Job runners:** look for `src/server/jobs/` or similar — pattern for the reconciliation cron
- **Model controllers / publish flow:** `src/server/controllers/model.controller.ts` or `src/server/services/model.service.ts` — for the publish hook
- **Existing zip extraction:** search the codebase for `JSZip`, `unzipper`, or `extract-zip` to find existing patterns
- **Backfill scripts:** check `scripts/` or wherever one-off operational scripts live

## 11. Definition of done

- `WildcardSet` rows exist for every published wildcard `ModelVersion` on the platform.
- New wildcard model publishes automatically create `WildcardSet` + categories within seconds.
- Reconciliation cron runs on schedule and is observable (success counts, failure alerts).
- Backfill script ran successfully against prod; counts verified.
- Tests passing; failure paths validated.
- The "create" button on wildcard model pages (separate work) can rely on `WildcardSet` rows existing for any published wildcard model and just look up the ID without falling back to a runtime first-import.

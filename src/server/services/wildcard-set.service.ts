import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  DeleteUserSnippetCategoryInput,
  GetWildcardSetsInput,
  LoadWildcardSetFromModelVersionInput,
  PreviewSnippetExpansionInput,
  RemoveUserSnippetInput,
  ReorderUserSnippetsInput,
  SaveUserSnippetInput,
  UpdateUserSnippetInput,
} from '~/server/schema/wildcard-set.schema';
import { submitWildcardCategoryAudit } from '~/server/services/wildcard-category-audit.service';
import { importWildcardModelVersion } from '~/server/services/wildcard-set-provisioning.service';
import { expandSnippetsToTargets } from '~/server/services/wildcard-set-resolver.service';
import { maxRandomSeed } from '~/server/common/constants';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

/**
 * Schedule an XGuard audit for a category whose content just changed. Fire-
 * and-forget by design: don't block the API response on orchestrator latency,
 * and never let a failed submit bubble up and fail the user's save. The
 * periodic `audit-wildcard-set-categories` cron is the safety net for any
 * silent failures here — categories stay at `auditStatus: 'Pending'` until
 * the webhook callback lands.
 */
function scheduleAudit(categoryId: number): void {
  submitWildcardCategoryAudit(categoryId).catch((err) =>
    logToAxiom({
      type: 'error',
      name: 'wildcard-set-service',
      message: 'failed to schedule audit after User-kind mutation',
      wildcardSetCategoryId: categoryId,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined)
  );
}

const DEFAULT_USER_SET_NAME = 'My snippets';

/**
 * Find the caller's User-kind `WildcardSet` and return its id, or `null` if
 * the user doesn't have one. v1 deliberately does NOT lazy-create here —
 * "Save to my snippets" and the auto-created "My snippets" set are deferred
 * post-v1 (System-kind sets imported from Wildcards models are the only
 * supported path in v1). Callers that need a set throw a friendly error
 * when this returns null.
 */
async function findUserSetId(tx: Prisma.TransactionClient, userId: number): Promise<number | null> {
  const existing = await tx.wildcardSet.findFirst({
    where: { kind: 'User', ownerUserId: userId },
    select: { id: true },
  });
  return existing?.id ?? null;
}

const wildcardSetSelect = {
  id: true,
  kind: true,
  modelVersionId: true,
  ownerUserId: true,
  name: true,
  auditStatus: true,
  isInvalidated: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Deliberately omits `values: true`. The client never holds the values
// array except while a user is actively selecting `in`/`ex` values inside
// the picker for a specific category. v1 has no such picker, so v1 clients
// receive zero values from this surface. Post-v1, the picker fetches
// values only for the category whose drawer is open — not the full
// loaded-sets payload. The server-side resolver fetches values directly
// via its own query, so values never leave the server outside of that
// narrow picker-open path.
//
// Also omits `auditStatus`: the read query filters to Clean only (see the
// `where` clauses on `categories` below), so every row a client receives is
// usable by definition. Pending/Dirty categories are server-side-only state
// and don't need a client-visible field.
const wildcardSetCategorySelect = {
  id: true,
  wildcardSetId: true,
  name: true,
  valueCount: true,
  nsfw: true,
  displayOrder: true,
} as const;

/**
 * Authorization filter for read access. System-kind sets are public; User-kind
 * sets are owner-only. Mirrors the same predicate the resolver uses inline at
 * generation time (see schema doc §6.2). Returns a Prisma `where` fragment.
 */
function authorizationWhere(userId: number): Prisma.WildcardSetWhereInput {
  return {
    OR: [{ kind: 'System' }, { kind: 'User', ownerUserId: userId }],
  };
}

/**
 * Hydrate the full set + category payload for an explicit list of IDs. Used by
 * the form on mount (after reading `wildcardSetIds` from localStorage and
 * unioning with the user's own User-kind set id) to render the picker. IDs the
 * user isn't authorized for or that no longer exist are silently dropped — the
 * client treats those as stale localStorage entries.
 *
 * Invalidated sets are included with a flag (`isInvalidated: true`) so the
 * form can render a warning chip and offer to remove them, but their
 * categories are NOT returned (the picker shouldn't surface unusable values).
 */
export async function getWildcardSets({
  userId,
  input,
}: {
  userId: number;
  input: GetWildcardSetsInput;
}) {
  const sets = await dbRead.wildcardSet.findMany({
    where: {
      id: { in: input.ids },
      ...authorizationWhere(userId),
      // Hide fully-Dirty sets from clients entirely — every category in a
      // Dirty set has triggered XGuard, so there's nothing safe to surface.
      // Mixed sets stay visible (they have at least one Clean category) and
      // get their Dirty categories filtered at the relation below.
      auditStatus: { not: 'Dirty' },
    },
    select: {
      ...wildcardSetSelect,
      // System-kind sets surface their backing model so the active-wildcards
      // chip can deep-link to `/models/{modelId}/{slug}?modelVersionId=…`.
      // User-kind sets have `modelVersion = null` and the chip renders
      // without a link.
      modelVersion: {
        select: { id: true, modelId: true, model: { select: { name: true } } },
      },
      categories: {
        // Strict gate: only Clean categories are surfaced to the picker.
        // Pending categories aren't ready yet (no verdict, nsfw unknown) and
        // Dirty categories failed audit outright. The audit-on-mutation hook
        // in saveUserSnippet / updateUserSnippet / removeUserSnippet refires
        // a workflow whenever content changes, so a freshly-edited category
        // briefly disappears from the picker until its callback lands —
        // expected behavior.
        where: { auditStatus: 'Clean' },
        select: wildcardSetCategorySelect,
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      },
    },
    orderBy: { id: 'asc' },
  });

  // Strip categories from invalidated sets — the metadata stays so the form
  // can show the warning, but content shouldn't be selectable.
  return sets.map((set) =>
    set.isInvalidated ? { ...set, categories: [] as typeof set.categories } : set
  );
}

/**
 * Return the caller's User-kind WildcardSet, or `null` if they don't have
 * one. v1 doesn't lazy-create — User-kind sets ("Save to my snippets") are
 * deferred post-v1, so a first-time form mount always sees `null` here and
 * shouldn't render any User-kind affordance. The form hook handles `null`
 * by surfacing only System-kind sets the user has explicitly added.
 */
export async function getMyUserWildcardSet({ userId }: { userId: number }) {
  return dbRead.wildcardSet.findFirst({
    where: { kind: 'User' as const, ownerUserId: userId },
    select: {
      ...wildcardSetSelect,
      // Always `null` for User-kind sets; selected for shape parity with
      // `getWildcardSets` so the union the form's hook builds carries a
      // consistent type.
      modelVersion: {
        select: { id: true, modelId: true, model: { select: { name: true } } },
      },
      categories: {
        // Strict gate matching getWildcardSets — see the comment there.
        where: { auditStatus: 'Clean' as const },
        select: wildcardSetCategorySelect,
        orderBy: [{ displayOrder: 'asc' as const }, { id: 'asc' as const }],
      },
    },
  });
}

/**
 * Append a snippet value to the caller's User-kind set. Lazy-creates the set
 * (named "My snippets") and the category as needed. Idempotent on duplicates —
 * saving the same value twice is a no-op rather than an error, matching how
 * users intuitively expect a "save" affordance to behave.
 *
 * Every mutation flips the affected category back to `auditStatus: Pending`
 * and bumps the parent set's `totalValueCount`. The audit pipeline (post-v1)
 * will pick up Pending categories and re-verdict them.
 */
export async function saveUserSnippet({
  userId,
  input,
}: {
  userId: number;
  input: SaveUserSnippetInput;
}) {
  const result = await dbWrite.$transaction(async (tx) => {
    const setId = await findUserSetId(tx, userId);
    if (setId === null) {
      // v1 deliberately doesn't lazy-create User-kind sets. "Save to my
      // snippets" is deferred post-v1, so this path should be unreachable
      // from the v1 UI — throwing is the safety net for a stale client.
      throw throwBadRequestError(
        'Saving personal snippets is not available yet — only imported wildcard sets are supported in this release.'
      );
    }

    // Find or create the category, then append the value if not present.
    const existingCategory = await tx.wildcardSetCategory.findUnique({
      where: { wildcardSetId_name: { wildcardSetId: setId, name: input.category } },
      select: { id: true, values: true, valueCount: true },
    });

    if (!existingCategory) {
      const maxDisplayOrder = await tx.wildcardSetCategory.aggregate({
        where: { wildcardSetId: setId },
        _max: { displayOrder: true },
      });
      const created = await tx.wildcardSetCategory.create({
        data: {
          wildcardSetId: setId,
          name: input.category,
          values: [input.value],
          valueCount: 1,
          displayOrder: (maxDisplayOrder._max.displayOrder ?? -1) + 1,
          auditStatus: 'Pending',
          nsfw: false,
        },
        select: wildcardSetCategorySelect,
      });
      return { set: { id: setId }, category: created, added: true };
    }

    if (existingCategory.values.includes(input.value)) {
      // Idempotent: already saved. Return the existing row unchanged.
      const category = await tx.wildcardSetCategory.findUnique({
        where: { id: existingCategory.id },
        select: wildcardSetCategorySelect,
      });
      return { set: { id: setId }, category, added: false };
    }

    const updated = await tx.wildcardSetCategory.update({
      where: { id: existingCategory.id },
      data: {
        values: [...existingCategory.values, input.value],
        valueCount: existingCategory.valueCount + 1,
        auditStatus: 'Pending',
      },
      select: wildcardSetCategorySelect,
    });
    return { setId, category: updated, added: true };
  });

  // Fire audit ONLY when the value was actually added — `added: false` means
  // the value was a duplicate and the category is unchanged, no re-audit
  // needed. Runs after the transaction commits so a rolled-back save can't
  // leak an audit submission for stale state.
  if (result.added && result.category) {
    scheduleAudit(result.category.id);
  }

  return result;
}

/**
 * Remove a single value from a User-kind category the caller owns. If that was
 * the last value, the category itself is deleted (we don't carry empty
 * categories — they'd just be picker noise).
 */
export async function removeUserSnippet({
  userId,
  input,
}: {
  userId: number;
  input: RemoveUserSnippetInput;
}) {
  const result = await dbWrite.$transaction(async (tx) => {
    const category = await loadOwnedUserCategory(tx, { userId, categoryId: input.categoryId });
    const idx = category.values.indexOf(input.value);
    if (idx < 0) throw throwNotFoundError('Snippet value not found in this category');

    const remaining = [...category.values.slice(0, idx), ...category.values.slice(idx + 1)];

    if (remaining.length === 0) {
      await tx.wildcardSetCategory.delete({ where: { id: category.id } });
      return { categoryDeleted: true as const, categoryId: category.id };
    }

    const updated = await tx.wildcardSetCategory.update({
      where: { id: category.id },
      data: {
        values: remaining,
        valueCount: remaining.length,
        auditStatus: 'Pending',
      },
      select: wildcardSetCategorySelect,
    });
    return { categoryDeleted: false as const, category: updated };
  });

  // Re-audit when the category still has values left. When the last value
  // was removed the category itself is deleted, so there's nothing to audit.
  if (!result.categoryDeleted) {
    scheduleAudit(result.category.id);
  }

  return result;
}

/**
 * Replace one occurrence of `oldValue` with `newValue` in a User-kind category
 * the caller owns. Position is preserved. If `newValue` is already present
 * elsewhere in the same category, the duplicate is collapsed (not an error)
 * to keep the values array a deduplicated set in practice.
 */
export async function updateUserSnippet({
  userId,
  input,
}: {
  userId: number;
  input: UpdateUserSnippetInput;
}) {
  if (input.oldValue === input.newValue) {
    throw throwBadRequestError('newValue must differ from oldValue');
  }
  const result = await dbWrite.$transaction(async (tx) => {
    const category = await loadOwnedUserCategory(tx, { userId, categoryId: input.categoryId });
    const idx = category.values.indexOf(input.oldValue);
    if (idx < 0) throw throwNotFoundError('Snippet value not found in this category');

    const next = [...category.values];
    next[idx] = input.newValue;
    // Drop any duplicates of the new value that already existed at a different
    // position — keep the just-edited one in place.
    const deduped = next.filter((v, i) => i === idx || v !== input.newValue);

    const updated = await tx.wildcardSetCategory.update({
      where: { id: category.id },
      data: {
        values: deduped,
        valueCount: deduped.length,
        auditStatus: 'Pending',
      },
      select: wildcardSetCategorySelect,
    });
    return { category: updated };
  });

  // Content changed — always re-audit.
  scheduleAudit(result.category.id);

  return result;
}

/**
 * Replace the full ordered values array for a User-kind category the caller
 * owns. Used by the picker's drag-handle reorder UX. Caller must include
 * every value — partial reorders aren't supported (avoids set-vs-array
 * ambiguity). Duplicates within the supplied array are rejected so the
 * unique-per-category app-level invariant holds.
 */
export async function reorderUserSnippets({
  userId,
  input,
}: {
  userId: number;
  input: ReorderUserSnippetsInput;
}) {
  return dbWrite.$transaction(async (tx) => {
    const category = await loadOwnedUserCategory(tx, { userId, categoryId: input.categoryId });

    const seen = new Set<string>();
    for (const value of input.values) {
      if (seen.has(value)) {
        throw throwBadRequestError(`Duplicate value in reorder payload: ${value}`);
      }
      seen.add(value);
    }
    const existing = new Set(category.values);
    if (seen.size !== existing.size || [...existing].some((v) => !seen.has(v))) {
      throw throwBadRequestError(
        'Reorder payload must contain exactly the existing values (additions/removals must use save/remove)'
      );
    }

    const updated = await tx.wildcardSetCategory.update({
      where: { id: category.id },
      data: {
        values: input.values,
        // valueCount unchanged — same set of values, different order.
        // auditStatus unchanged — pure reorder doesn't introduce new content.
      },
      select: wildcardSetCategorySelect,
    });
    return { category: updated };
  });
}

/**
 * Delete an entire User-kind category the caller owns and decrement the
 * parent set's `totalValueCount`. The set itself is preserved even if all
 * its categories are deleted — keeping it lets the user keep building up
 * content again without re-bootstrapping the row.
 */
export async function deleteUserSnippetCategory({
  userId,
  input,
}: {
  userId: number;
  input: DeleteUserSnippetCategoryInput;
}) {
  return dbWrite.$transaction(async (tx) => {
    const category = await loadOwnedUserCategory(tx, { userId, categoryId: input.categoryId });
    await tx.wildcardSetCategory.delete({ where: { id: category.id } });
    return { categoryId: category.id, removedValues: category.valueCount };
  });
}

/**
 * Verify the category exists, belongs to a User-kind set, and is owned by the
 * caller. Used by every mutation as the authorization gate. Returns the
 * category row plus its parent's `wildcardSetId` for downstream updates.
 */
async function loadOwnedUserCategory(
  tx: Prisma.TransactionClient,
  { userId, categoryId }: { userId: number; categoryId: number }
) {
  const category = await tx.wildcardSetCategory.findUnique({
    where: { id: categoryId },
    select: {
      id: true,
      wildcardSetId: true,
      values: true,
      valueCount: true,
      wildcardSet: { select: { kind: true, ownerUserId: true } },
    },
  });
  if (!category) throw throwNotFoundError('Snippet category not found');
  if (category.wildcardSet.kind !== 'User' || category.wildcardSet.ownerUserId !== userId) {
    throw throwAuthorizationError();
  }
  return category;
}

/**
 * Resolve a `Wildcards`-type `ModelVersion` to a `WildcardSet.id`, importing
 * the set on-demand if needed. Idempotent — repeated calls with the same
 * `modelVersionId` always return the same id (the underlying provisioning
 * service handles the find-or-create + concurrent-import race via the
 * unique constraint).
 *
 * Wired to the form's "Add wildcard set" affordance: when a user picks a
 * wildcard from the resource select modal, the client hands the version id
 * here; the result is the `WildcardSet.id` to add to the snippets node's
 * `wildcardSetIds`.
 *
 * Outcomes from the provisioning service map to user-facing behavior:
 *   - `created` / `already_exists` — return the id, caller adds it to the form
 *   - `invalidated` — set exists but content is unusable (corrupt zip, etc).
 *     Returns the id with `invalidated: true` so the caller can show the
 *     red-badged ActiveWildcards chip rather than silently failing.
 *   - `unsupported_format` — no `WildcardSet` was created (we'll come back
 *     when we add support). Surface a friendly error to the user.
 *   - `failed` — transient transport/transaction error. Surface the error;
 *     the user can retry.
 */
export async function loadWildcardSetFromModelVersion({
  input,
}: {
  userId: number;
  input: LoadWildcardSetFromModelVersionInput;
}) {
  const result = await importWildcardModelVersion(input.modelVersionId);
  switch (result.status) {
    case 'created':
    case 'already_exists':
      return { wildcardSetId: result.wildcardSetId, invalidated: false };
    case 'invalidated':
      return { wildcardSetId: result.wildcardSetId, invalidated: true, reason: result.reason };
    case 'unsupported_format':
      throw throwBadRequestError(
        `This wildcard model uses a file format we don't yet support (${result.fileNames.join(', ')}). The site will pick it up automatically once support lands.`
      );
    case 'failed':
      throw throwBadRequestError(`Couldn't load wildcard set: ${result.error}`);
  }
}

/**
 * Run a single snippet expansion against the caller's loaded sets and return
 * the resolved sample. Used by the form's "Preview" button so the user can
 * sanity-check a substitution before submitting a real generation.
 *
 * Always runs with `mode: 'random'`, `batchCount: 1`, and no per-value
 * selections (full pool) — preview is meant to be a quick look at what the
 * resolver will produce, not a full batch enumeration. When the caller passes
 * a `seed`, the preview is deterministic; when omitted, the server samples a
 * fresh seed and returns it so the form can re-render the same preview if
 * it needs to (e.g. unpoll-then-repoll).
 *
 * Authorization is enforced inline by `expandSnippetsToTargets` against the
 * provided `wildcardSetIds`: System-kind sets are public, User-kind sets must
 * match `userId`. Unauthorized IDs are silently dropped from the pool.
 *
 * The returned `targets` map only includes the keys the caller asked about
 * (e.g. `prompt` without `negativePrompt` when the form omitted it). Empty
 * templates pass through verbatim. The `diagnostics` field surfaces the
 * resolver's per-reference pool sizes and any unresolved references so the
 * form can show "no values for #character" warnings inline with the preview.
 */
export async function previewSnippetExpansion({
  userId,
  isGreen,
  input,
}: {
  userId: number;
  /** Site context — `.com` (SFW) vs `.red` (NSFW). Filters categories by `nsfw`. */
  isGreen: boolean;
  input: PreviewSnippetExpansionInput;
}) {
  const seed = input.seed ?? Math.floor(Math.random() * maxRandomSeed);

  // The schema already drops keys whose template is `undefined` via the
  // `z.record(z.string(), z.string())` typing — `input.targets` is a clean
  // map. Empty record is valid.
  const targetTemplates: Record<string, string> = { ...input.targets };

  const result = await expandSnippetsToTargets({
    snippets: {
      wildcardSetIds: input.wildcardSetIds,
      mode: 'random',
      batchCount: 1,
      targets: {},
    },
    targetTemplates,
    seed,
    userId,
    isGreen,
  });

  // batchCount=1 → exactly one expansion record. Falling back to an empty
  // object covers the degenerate "no targets, no refs" case so the response
  // shape stays stable regardless of input.
  return {
    seed,
    targets: result.expansions[0] ?? {},
    diagnostics: result.diagnostics,
  };
}

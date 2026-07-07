/**
 * App Store Listings (W13) — /apps/my-submissions table view-model logic (PURE,
 * no React). Shared by BOTH lists (onsite `MySubmissionsList` + offsite
 * `OffsiteSubmissionsList`) so the text filter, the column comparators, and the
 * per-app version-collapse behave IDENTICALLY across them. Extracted so each piece
 * is unit-testable without mounting a table.
 *
 * The two row shapes differ (onsite has a block id + version; offsite has a slug +
 * external URL), so every helper here is GENERIC over the row type `T` and reads
 * the sortable / filterable / identity fields through a small `SubmissionAccessors`
 * adapter the caller supplies. That keeps this module free of any dependency on the
 * concrete `Submission` / `OffsiteSubmission` types.
 */

/** Sortable columns shared by both tables. */
export type SortColumn = 'app' | 'status' | 'submitted' | 'reviewed';
export type SortDirection = 'asc' | 'desc';
export type SortState = { column: SortColumn; direction: SortDirection };

/**
 * Status sort order (pending → approved → rejected → withdrawn): active/actionable
 * first, terminal last. An unknown status sorts after all known ones (kept stable
 * by an alphabetical tiebreak) so a future status degrades gracefully.
 */
export const STATUS_SORT_ORDER: Readonly<Record<string, number>> = {
  pending: 0,
  approved: 1,
  rejected: 2,
  withdrawn: 3,
};

export function statusRank(status: string): number {
  return STATUS_SORT_ORDER[status] ?? Number.MAX_SAFE_INTEGER;
}

/** Coerce a `string | Date | null | undefined` timestamp to a `Date | null`. */
export function toDate(d: string | Date | null | undefined): Date | null {
  if (d == null) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Field adapters for a concrete row type. `name` is the human app name (fall back
 * to the slug when a row has none), `slug` the URL slug, `identity` the
 * version-collapse key (offsite = slug, onsite = the block/app id).
 */
export type SubmissionAccessors<T> = {
  identity: (row: T) => string;
  name: (row: T) => string;
  slug: (row: T) => string;
  status: (row: T) => string;
  submittedAt: (row: T) => Date | null;
  reviewedAt: (row: T) => Date | null;
};

/** A collapsed per-app group: the newest request + the older ones (newest-first). */
export type SubmissionGroup<T> = {
  identity: string;
  latest: T;
  older: T[];
  versionCount: number;
};

// ── comparators (pure, primitive-typed — unit-tested independently) ────────────

/** Case-insensitive text compare (App column). */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Status compare by {@link statusRank}, alphabetical tiebreak for equal ranks. */
export function compareStatus(a: string, b: string): number {
  const ra = statusRank(a);
  const rb = statusRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.localeCompare(b);
}

/** Date compare; a null date sorts as the OLDEST (so direction flips it cleanly). */
export function compareDate(a: Date | null, b: Date | null): number {
  const ta = a ? a.getTime() : -Infinity;
  const tb = b ? b.getTime() : -Infinity;
  if (ta === tb) return 0;
  return ta < tb ? -1 : 1;
}

// ── filter ─────────────────────────────────────────────────────────────────────

/** Case-insensitive substring match of a query against a row's name OR slug. */
export function matchesQuery(name: string, slug: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return name.toLowerCase().includes(q) || slug.toLowerCase().includes(q);
}

// ── group / collapse ─────────────────────────────────────────────────────────

/**
 * Collapse rows by app identity. Groups preserve first-seen order; within a group
 * the rows are sorted newest-first by `submittedAt`, so `latest` is the newest
 * request and `older` the rest (newest-first). PURE — never mutates the input.
 */
export function groupSubmissionsByApp<T>(
  rows: readonly T[],
  identityOf: (row: T) => string,
  submittedAtOf: (row: T) => Date | null
): SubmissionGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const id = identityOf(row);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  const result: SubmissionGroup<T>[] = [];
  for (const [identity, members] of buckets) {
    const sorted = [...members].sort(
      (a: T, b: T) =>
        (submittedAtOf(b)?.getTime() ?? -Infinity) - (submittedAtOf(a)?.getTime() ?? -Infinity)
    );
    const latest = sorted[0];
    if (latest === undefined) continue; // unreachable (buckets never empty) — type guard
    result.push({ identity, latest, older: sorted.slice(1), versionCount: sorted.length });
  }
  return result;
}

// ── filter + sort over the grouped view ────────────────────────────────────────

/** Keep a group if ANY of its versions matches the query (name or slug). */
export function filterGroups<T>(
  groups: readonly SubmissionGroup<T>[],
  query: string,
  accessors: SubmissionAccessors<T>
): SubmissionGroup<T>[] {
  const q = query.trim();
  if (q.length === 0) return [...groups];
  return groups.filter((g: SubmissionGroup<T>) =>
    [g.latest, ...g.older].some((row: T) =>
      matchesQuery(accessors.name(row), accessors.slug(row), q)
    )
  );
}

/**
 * Sort groups by the chosen column's value on each group's `latest` request.
 * Stable (Array.prototype.sort is stable), non-mutating. `direction` flips the
 * base comparator.
 */
export function sortGroups<T>(
  groups: readonly SubmissionGroup<T>[],
  sort: SortState,
  accessors: SubmissionAccessors<T>
): SubmissionGroup<T>[] {
  const factor = sort.direction === 'asc' ? 1 : -1;
  const base = (a: SubmissionGroup<T>, b: SubmissionGroup<T>): number => {
    const la = a.latest;
    const lb = b.latest;
    switch (sort.column) {
      case 'app':
        return compareText(accessors.name(la), accessors.name(lb));
      case 'status':
        return compareStatus(accessors.status(la), accessors.status(lb));
      case 'submitted':
        return compareDate(accessors.submittedAt(la), accessors.submittedAt(lb));
      case 'reviewed':
        return compareDate(accessors.reviewedAt(la), accessors.reviewedAt(lb));
    }
  };
  return [...groups].sort((a: SubmissionGroup<T>, b: SubmissionGroup<T>) => factor * base(a, b));
}

/** The next sort state when a column header is clicked: toggle direction on the
 *  same column, else switch to the new column with a sensible default direction
 *  (text/status default asc, dates default desc = newest first). */
export function nextSortState(current: SortState, column: SortColumn): SortState {
  if (current.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  const defaultDirection: SortDirection =
    column === 'submitted' || column === 'reviewed' ? 'desc' : 'asc';
  return { column, direction: defaultDirection };
}

/** `aria-sort` value for a header, given the active sort state. */
export function ariaSortFor(
  sort: SortState,
  column: SortColumn
): 'ascending' | 'descending' | 'none' {
  if (sort.column !== column) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

type QueryValue = string | string[] | undefined;
type Query = Record<string, QueryValue>;

const ESCAPED_AMP_PREFIX = /^(?:amp;)+/;

function firstValue(value: QueryValue) {
  return Array.isArray(value) ? value[0] : value;
}

function toPositiveInt(value: QueryValue) {
  const raw = firstValue(value);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const num = Number(raw);
  return num > 0 ? num : undefined;
}

/**
 * The canonical URL of a model's reviews listing. The version filter is the only query param that
 * changes what the page lists, so it is the only one kept — and only when a version is selected.
 */
export function getModelReviewsCanonical(modelId: number, modelVersionId?: number | null) {
  const base = `/models/${modelId}/reviews`;
  return modelVersionId ? `${base}?modelVersionId=${modelVersionId}` : base;
}

/**
 * Where to send a request for a near-duplicate of the reviews listing, or `null` to render it.
 *
 * Each of these renders the same listing as its canonical URL:
 * - `dialog=resourceReview` (a single review dialog opened over the listing);
 * - the same dialog repeated (`dialog=resourceReview&dialog=resourceReview…`), which links built
 *   from an already-open dialog append to;
 * - `reviewId` without any dialog, which the listing ignores;
 * - a version param that is not a single positive integer — including `modelVersionId=undefined`,
 *   which this page once emitted as its own canonical;
 * - keys prefixed `amp;` — a link whose `&` was HTML-escaped twice before being followed, which
 *   hides every param from the page and, since dialog links are built from the current query,
 *   grows by one more `dialog` on every hop.
 *
 * Other dialog combinations (a review dialog with an image opened inside it) are left to render so a
 * reload keeps what the user was looking at; `Meta` already marks any `dialog` URL noindex.
 */
export function getModelReviewsRedirect(modelId: number, query: Query): string | null {
  const normalized: Query = {};
  let escaped = false;
  for (const [key, value] of Object.entries(query)) {
    const cleanKey = key.replace(ESCAPED_AMP_PREFIX, '');
    if (cleanKey !== key) escaped = true;
    if (value === undefined) continue;
    const prev = normalized[cleanKey];
    normalized[cleanKey] = prev === undefined ? value : ([] as string[]).concat(prev, value);
  }

  const dialogs = ([] as string[]).concat(normalized.dialog ?? []);
  const reviewDialogCount = dialogs.filter((d) => d === 'resourceReview').length;
  const rawVersion = normalized.modelVersionId;
  const modelVersionId = toPositiveInt(rawVersion);
  const isDuplicate =
    escaped ||
    // `?modelVersionId=undefined` (the old broken canonical) or a repeated version param
    (rawVersion !== undefined && (Array.isArray(rawVersion) || modelVersionId === undefined)) ||
    (dialogs.length === 1 && reviewDialogCount === 1) ||
    reviewDialogCount > 1 ||
    (dialogs.length === 0 && normalized.reviewId !== undefined);

  if (!isDuplicate) return null;
  return getModelReviewsCanonical(modelId, modelVersionId);
}

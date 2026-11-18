// Shared by the Node parity test (src/__tests__/parity.test.ts) and js-client-check.mjs: how a
// JS Flipt client evaluates one corpus case, reduced to the fields every client version reports.
// The Go side (go/parity_test.go) reduces its responses to the same shape; README.md in this
// directory says what each file is for.
//
// Reduced, not raw: a response also carries timing and timestamps (never equal across runs), the
// flag key (an echo of the request) and, from engine 0.4.0 on, boolean segment keys (absent from
// the pinned 0.2.0 build). An evaluation that throws is `{ error: true }`: the JS and Go SDKs word
// their errors differently, so the message is not compared, only that both refused.

/**
 * @typedef {{ id: string, kind: 'boolean' | 'variant', flagKey: string, entityId: string, context: Record<string, string> }} ParityCase
 * @typedef {{ enabled: boolean, reason: string }} BooleanResult
 * @typedef {{ match: boolean, variantKey: string, variantAttachment: string, segmentKeys: string[], reason: string }} VariantResult
 * @typedef {BooleanResult | VariantResult | { error: true }} ParityResult
 * @typedef {{ evaluateBoolean(req: { flagKey: string, entityId: string, context: Record<string, string> }): any, evaluateVariant(req: { flagKey: string, entityId: string, context: Record<string, string> }): any }} JsFliptClient
 */

/**
 * @param {JsFliptClient} client
 * @param {ParityCase} c
 * @returns {ParityResult}
 */
export function evaluateCase(client, c) {
  const req = { flagKey: c.flagKey, entityId: c.entityId, context: { ...c.context } };
  try {
    if (c.kind === 'boolean') {
      const r = client.evaluateBoolean(req);
      return { enabled: r.enabled === true, reason: String(r.reason) };
    }
    const r = client.evaluateVariant(req);
    return {
      match: r.match === true,
      variantKey: r.variantKey ?? '',
      variantAttachment: r.variantAttachment ?? '',
      segmentKeys: [...(r.segmentKeys ?? [])].sort(),
      reason: String(r.reason),
    };
  } catch {
    return { error: true };
  }
}

/**
 * A value with its object keys sorted, so two results compare by content whatever order their
 * keys were written in.
 * @param {unknown} v
 * @returns {unknown}
 */
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(/** @type {any} */ (v)[k]);
    return out;
  }
  return v;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export function sameResult(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * The cases whose result differs from the baseline, in corpus order.
 * @param {{ id: string, result: ParityResult }[]} baseline
 * @param {Map<string, ParityResult>} actual
 * @returns {{ id: string, baseline: ParityResult, latest: ParityResult }[]}
 */
export function divergencesFrom(baseline, actual) {
  const out = [];
  for (const c of baseline) {
    const got = actual.get(c.id);
    if (got === undefined) throw new Error(`no result for case ${c.id}`);
    if (!sameResult(c.result, got)) out.push({ id: c.id, baseline: c.result, latest: got });
  }
  return out;
}

/**
 * A fetcher answering every request with the snapshot, never touching the network. Both JS client
 * versions take an `IFetcher` and read `ok`, `status`, `headers.get` and `json()` from its answer.
 * @param {unknown} snapshot
 */
export function snapshotFetcher(snapshot) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => snapshot,
  });
}

/**
 * One case per line, so a regenerated file diffs per case; the generator owns this format
 * (.prettierignore lists these files).
 * @param {Record<string, unknown>} header
 * @param {string} listKey
 * @param {unknown[]} items
 */
export function formatLines(header, listKey, items) {
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, '');
  const body = items.map((i) => '    ' + JSON.stringify(i)).join(',\n');
  return `${head},\n  ${JSON.stringify(listKey)}: [\n${body}\n  ]\n}\n`;
}

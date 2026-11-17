/**
 * Splits the unit suite's test files across N shards by RECORDED COST instead of by file count.
 *
 * Vitest's own `--shard` sorts files by a path hash and cuts the list into equal-COUNT slices. This
 * suite's per-file cost is bimodal (a file either reaches the big core-service import graph or it
 * does not), so equal counts are not equal cost: on the 2026-11-17 cost table the count split's
 * heaviest shard carries 1.08x the mean at 4 shards, 1.19x at 6, 1.26x at 8.
 *
 * ⚠️ That is the smaller half of the spread CI shows. Runner speed varies ~1.65x within one run,
 * and no assignment can fix it; see the unit job's comment in .github/workflows/lint.yml for what
 * this split measurably buys once that noise is counted (a few percent, growing with N).
 *
 * The split is greedy longest-processing-time: files with a recorded cost go heaviest first, each
 * onto the shard with the least cost so far. Files with NO recorded cost (new, renamed, or the data
 * file is missing) are dealt round-robin afterwards, so missing data degrades balance and never
 * coverage.
 *
 * 🔴 EVERY SHARD COMPUTES THE WHOLE SPLIT AND KEEPS ITS OWN SLICE. That is only a partition if
 * every shard computes the SAME split, so the result must depend on nothing but the file list and
 * the cost table: input order is sorted away, and every tie is broken by the file key, never by
 * insertion order or by `Array.prototype.sort` stability over unsorted input.
 */

/**
 * @param {string[]} keys   one unique key per test file (the caller's identity for it)
 * @param {(key: string) => number | undefined} costOf  recorded cost in ms, or undefined
 * @param {number} count    number of shards, >= 1
 * @returns {number[]} the 0-based shard of each key, aligned with `keys`
 */
export function assignShards(keys, costOf, count) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`shard count must be >= 1, got ${count}`);
  if (new Set(keys).size !== keys.length) throw new Error('assignShards: keys must be unique');

  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const known = [];
  const unknown = [];
  keys.forEach((key, index) => {
    const cost = costOf(key);
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
      known.push({ key, index, cost });
    else unknown.push({ key, index });
  });

  const out = new Array(keys.length);
  const loads = new Array(count).fill(0);

  known.sort((a, b) => b.cost - a.cost || byKey(a, b));
  for (const f of known) {
    let best = 0;
    for (let s = 1; s < count; s++) if (loads[s] < loads[best]) best = s;
    loads[best] += f.cost;
    out[f.index] = best;
  }

  unknown.sort(byKey);
  unknown.forEach((f, i) => {
    out[f.index] = i % count;
  });

  return out;
}

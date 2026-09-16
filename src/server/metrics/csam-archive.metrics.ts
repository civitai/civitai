// CSAM evidence-archive PATH counter.
//
// 🔴 WHY THIS EXISTS: the archiver has had two code paths since #4771 — stage the
// two large media zips on the container's `scratch` emptyDir, or stream them
// straight to object storage — selected per report by the Flipt flag
// `csam-archive-stream-upload`. Nothing recorded which one ran. After the flag
// went live, archives completed and answering "did the streaming path actually
// run?" was impossible: the job emitted no path-identifying log line, and every
// existing `civitai_csam_*` series is monitor-level — pending / scanned /
// oldest-age / last-success — so none of them says anything about HOW an archive
// completed. The flag being on is not evidence the flagged branch executed.
//
// 🔴 WHAT `path` MEANS, AND THE TWO ARMS DIFFER — read this before alerting on it.
// On an `outcome="success"` row it is what RAN: `archiveAndUpload` branches on the
// flag with no internal fallback, so reaching the success arm means that branch
// executed. On an `outcome="error"` row it is only the path SELECTED for this
// report. `archivePath` is resolved before any archiving begins, so a failure
// upstream of the media archive — the base-bundle upload, an image count, a
// scratch-volume write — records the selected path even though that branch never
// executed. Concretely: `{path="stream", outcome="error"}` does NOT establish that
// the streaming upload failed. Read it as "a report routed to streaming failed
// somewhere", then use the log line's report id to find out where.
//
// 🔴 WHAT IS GENUINELY BETTER THAN READING THE FLAG: the `none` mapping. The flag
// is read once per report but governs `archiveImages`/`archiveGeneratedImages`
// only. A `TrainingData` report downloads a file it did not build, and an
// `ExternalLink` report archives no media at all — for both, the flag is read and
// then has nothing to select. Labelling those `stream` because the flag happened
// to be on would make the series a record of the flag rather than of the code.
// For `Image`/`GeneratedImage` — the only two types where `stream` and `disk` can
// differ at all — an ERROR row's `path` is, in fact, exactly what the flag said.
//
// 🔴 ALERTING: use `max_over_time(...[window])`, NOT `rate()` / `increase()`.
// Same hazard as `generation-model-substitution.metrics.ts`, and worse here: CSAM
// archives are RARE, spread over a multi-pod jobs pool, so a pod that archives
// once creates its child at 1 and never touches it again. A `rate()` over that
// child is structurally 0, and an alert keyed on it silently never fires — the
// counter would look healthiest exactly when the thing it watches is happening.
//
// 🔴 CARDINALITY: 12 series, total, and every one of them is REACHABLE — see
// REACHABLE_SERIES below. The naive product is 3 x 4 x 2 = 24, but half of those
// are combinations the code cannot produce (`ExternalLink` + `stream`, `Image` +
// `none`, ...). Seeding the impossible ones would put permanent zeros on screen
// that no code path can ever move, which reads as "this never happens" when it
// means "this cannot happen". Deliberately NO report id, user id, or byte count:
// this runs on the jobs pool where prom-client retains every distinct label set
// in the Node heap for the process lifetime, and the per-report detail belongs in
// the log line the service already emits beside this.
import client, { type Counter, type Registry } from 'prom-client';

import type { CsamReportType } from '~/shared/utils/prisma/models';

export const CSAM_ARCHIVE_PATHS = ['stream', 'disk', 'none'] as const;
export type CsamArchivePath = (typeof CSAM_ARCHIVE_PATHS)[number];

export const CSAM_ARCHIVE_TYPES = [
  'Image',
  'GeneratedImage',
  'TrainingData',
  'ExternalLink',
] as const;
export type CsamArchiveType = (typeof CSAM_ARCHIVE_TYPES)[number];

export const CSAM_ARCHIVE_OUTCOMES = ['success', 'error'] as const;
export type CsamArchiveOutcome = (typeof CSAM_ARCHIVE_OUTCOMES)[number];

/**
 * 🔴 COMPILE-TIME PIN AGAINST THE PRISMA ENUM — this is a GUARD, not documentation.
 *
 * `CSAM_ARCHIVE_TYPES` restates `CsamReportType` as a runtime array (a type alone
 * cannot be iterated to seed series, and `isCsamArchiveType` needs values). A
 * restatement drifts silently, and the drift is invisible at every other layer:
 * a new report type would make `csamArchivePathFor` return `'none'` (no
 * `FLAG_GOVERNED_TYPES` match), make the log line say "via the none path" for a
 * type that may well build a media archive, and make `recordCsamArchive` DROP the
 * call outright (`isCsamArchiveType` false) — so the new type would be absent from
 * the counter with no error, no log and no failing test.
 *
 * This fails the BUILD in both directions instead. Adding a member to either union
 * without the other is a type error here, at the one place that can see both.
 */
type AssertTrue<T extends true> = T;
// Unused BY CONSTRUCTION — the assertion IS the check, and it fires at compile time. There is
// nothing to reference it from; referencing it would not make it stronger.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CsamArchiveTypesMatchPrisma = AssertTrue<
  [CsamArchiveType] extends [CsamReportType]
    ? [CsamReportType] extends [CsamArchiveType]
      ? true
      : false
    : false
>;

/**
 * Report types whose media archive is built by this code, and are therefore
 * actually selected by the flag. Everything else gets `path: 'none'`.
 */
const FLAG_GOVERNED_TYPES: readonly CsamArchiveType[] = ['Image', 'GeneratedImage'];

/**
 * The path a report of this type takes, given the flag value read for it.
 *
 * 🔴 This is the ONLY place the flag-to-path mapping is expressed, so the counter
 * and the log line cannot disagree about what ran — they both call this.
 */
export function csamArchivePathFor(
  type: CsamArchiveType,
  streamArchivesToStorage: boolean
): CsamArchivePath {
  if (!FLAG_GOVERNED_TYPES.includes(type)) return 'none';
  return streamArchivesToStorage ? 'stream' : 'disk';
}

/**
 * Every (path, type) pair the code above can actually produce. Derived from
 * `csamArchivePathFor` rather than written out, so the two cannot drift: adding a
 * type or a path to the unions extends this automatically, and a test asserts the
 * count.
 */
export const REACHABLE_SERIES: ReadonlyArray<{ path: CsamArchivePath; type: CsamArchiveType }> =
  CSAM_ARCHIVE_TYPES.flatMap((type) =>
    [true, false]
      .map((flag) => csamArchivePathFor(type, flag))
      // A type that ignores the flag yields 'none' for both values; dedupe so it
      // contributes one pair, not two identical ones.
      .filter((path, i, all) => all.indexOf(path) === i)
      .map((path) => ({ path, type }))
  );

function isCsamArchivePath(v: unknown): v is CsamArchivePath {
  return CSAM_ARCHIVE_PATHS.includes(v as CsamArchivePath);
}
function isCsamArchiveType(v: unknown): v is CsamArchiveType {
  return CSAM_ARCHIVE_TYPES.includes(v as CsamArchiveType);
}
function isCsamArchiveOutcome(v: unknown): v is CsamArchiveOutcome {
  return CSAM_ARCHIVE_OUTCOMES.includes(v as CsamArchiveOutcome);
}

/**
 * Initialise all 12 reachable series to 0 at registration.
 *
 * 🔴 WHY THIS IS NOT COSMETIC, and why it matters more here than almost anywhere
 * else in this repo: prom-client materialises a child only on its first `inc()`,
 * and CSAM archives are rare. Without seeding, a pool that has not archived
 * anything recently exposes NOTHING, and `civitai_csam_archive_total{path="stream"}`
 * returns `no data` — indistinguishable from "the instrument was never wired",
 * which is precisely the state this counter was added to escape. A real zero and
 * an absent series must be tellable apart, and on a rare event the honest reading
 * is a row of zeros for most of the counter's life.
 *
 * 🔴 SEEDING ALONE IS NOT ENOUGH. `ensureRegister…` has no caller on the archive
 * path before the first archive, so the series would still be absent until an
 * event happened. The other half is the side-effect call in
 * `src/pages/api/metrics.ts`, which runs on the first scrape. Both halves are
 * required; neither works alone.
 *
 * Idempotent: `getOrCreateCounter` returns the existing counter and `inc(…, 0)` is
 * a no-op on an already-materialised series, so calling this per request cannot
 * reset or double-count.
 */
function seedAllSeries(counter: Counter<string>): void {
  for (const { path, type } of REACHABLE_SERIES) {
    for (const outcome of CSAM_ARCHIVE_OUTCOMES) counter.inc({ path, type, outcome }, 0);
  }
}

function getOrCreateCounter(
  reg: Registry,
  name: string,
  help: string,
  labelNames: string[]
): Counter<string> {
  const existing = reg.getSingleMetric(name) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({ name, help, labelNames, registers: [reg] });
}

/**
 * Idempotent: safe to call on every request. Returns the counter from the default
 * registry that /api/metrics scrapes.
 */
export function ensureRegisterCsamArchiveMetrics(reg: Registry = client.register): {
  csamArchiveTotal: Counter<string>;
} {
  const csamArchiveTotal = getOrCreateCounter(
    reg,
    'civitai_csam_archive_total',
    'CSAM evidence-archive attempts that reached the archive stage, by the media-archive path selected for them. ' +
      'NOT every terminal state: a report with no reported user is stamped archived and returns BEFORE the flag is read, and a scratch-volume mkdir failure throws before the try block, so neither is counted here — the first is visible as details.archiveSkipped, the second only in the log line. ' +
      'On outcome=success, path is what RAN. On outcome=error it is only the path SELECTED: the failure may be upstream of the media archive, so {path="stream",outcome="error"} does not establish that streaming failed. ' +
      'path (stream = the two large media zips were streamed straight to object storage, the #4771 path behind the csam-archive-stream-upload flag; ' +
      'disk = they were staged on the container scratch emptyDir first, the long-standing path and the flag-off rollback; ' +
      'none = this report type builds no large media archive here, so the flag selected nothing — TrainingData downloads a prebuilt file and ExternalLink archives only base user data). ' +
      'type = CsamReport.type. outcome (success = archivedAt was set; error = the per-report archive threw). ' +
      'RARE EVENT: alert with max_over_time(), never rate()/increase() — a pod that archives once sets its child to 1 and never moves it again.',
    ['path', 'type', 'outcome']
  );
  seedAllSeries(csamArchiveTotal);
  return { csamArchiveTotal };
}

/**
 * Fail-soft emit of one terminal archive attempt.
 *
 * 🔴 TOTAL, like every emitter in this directory. This instruments the CSAM
 * evidence path, which is a legal-reporting obligation: a metrics error
 * (registry collision, label mismatch) must never propagate and turn an archive
 * that actually succeeded into a failed one. Observability must not be able to
 * cause the outage it is watching for.
 */
export function recordCsamArchive(
  path: CsamArchivePath,
  type: CsamArchiveType,
  outcome: CsamArchiveOutcome
): void {
  try {
    // 🔴 The cardinality bound rests HERE, on code, not on the erased types above.
    // An unknown value is DROPPED rather than passed through or relabelled to a
    // plausible default — either would make the "12 series" claim a wish.
    if (!isCsamArchivePath(path) || !isCsamArchiveType(type) || !isCsamArchiveOutcome(outcome))
      return;
    const { csamArchiveTotal } = ensureRegisterCsamArchiveMetrics();
    csamArchiveTotal.inc({ path, type, outcome });
  } catch {
    /* instrument-only — never let a metrics error touch the CSAM archive path */
  }
}

import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';

type Finding = AbuseReportInput['findings'][number];

/** The `detector` key the board groups runs under. Opaque — the board titles it verbatim. */
export const SHARED_STORAGE_REPORT_DETECTOR = 'app-blocks-shared-storage-report';

/** The wire contract's own cap on `reason`. Restated because the truncation below is arithmetic on
 *  it, and a literal in two places drifts. */
const MAX_REASON_LENGTH = 2_000;

/**
 * Per-reporter free text, after sanitisation.
 *
 * 🔴 THIS IS THE REPLACEMENT FOR `sanitizeDiscordText`, NOT A DROP OF IT. That function existed
 * because the reason was interpolated into a Discord message, where `[label](https://phish.example)`
 * renders as a masked link in a moderator channel. The board is a different renderer — Svelte
 * interpolates `{finding.reason}` as TEXT, so nothing in this string can execute or link — but the
 * text is still hostile-authored and still read by moderators, so the bound does not go away:
 *
 *   - hard length cap, which is now LOAD-BEARING in a way the Discord one was not: a `reason` over
 *     2,000 chars does not lose one finding, it 400s the REPORT and loses every finding in the batch;
 *   - single-lining, so one reporter cannot push the rest of a run's row off a moderator's screen;
 *   - the same markdown/masked-link structural strip, kept rather than dropped because it costs one
 *     regex and the board's renderer is not this file's to promise. If `{@html}` ever appears there,
 *     or if a finding is ever piped back out to a chat surface, this is what stops it mattering.
 */
const MAX_REPORTER_TEXT = 500;

/** How many reporters / free-text quotes one finding renders before it says "and N more". Bounded so
 *  a brigaded row cannot spend the whole 2,000-char reason budget on a reporter list. */
const MAX_REPORTERS_RENDERED = 10;
const MAX_REASONS_RENDERED = 5;

/**
 * One reported shared-storage row, with every user report filed against it in this window folded in.
 *
 * 🔴 THERE IS NO FIELD FOR THE REPORTED CONTENT, AND THAT IS THE POINT. The reported row's `value`
 * jsonb holds the moderated title/body a user wrote; this board is a wider-audience surface than the
 * app's own moderation view, so the content never leaves the apps database. Everything here is
 * METADATA — who, where, which row, and what the reporter SAID about it. The reader
 * (`reader.ts`) does not select `value` either, so this is enforced twice, once structurally.
 */
export type ReportedRow = {
  /** App slug (the `app_<slug>` storage schema, minus the prefix). */
  slug: string;
  /** The `apb_<ulid>` AppBlock id, when the slug resolved to a live approved block. */
  appBlockId: string | null;
  /** The reported `shared_kv` row key (a server-generated ULID). */
  key: string;
  /**
   * The account the finding is ABOUT: the author of the reported row.
   *
   * 🔴 NOT THE REPORTER. `abuseFinding.userId` is documented on the contract as "the account the
   * finding is ABOUT. Not an actor." — so filing the reporter here would put the person who flagged
   * the abuse in the moderator queue as its subject. Reporter ids go in the reason, as metadata.
   */
  authorUserId: number;
  /** The row has already been soft-hidden by a moderator (`shared_kv.hidden_at IS NOT NULL`). */
  hidden: boolean;
  /** Distinct reporter user ids, in the order their reports were filed. */
  reporterUserIds: number[];
  /** Reporter free text, one entry per report, RAW — sanitised at render, not at collection. */
  reasons: string[];
  firstReportedAt: Date;
  lastReportedAt: Date;
};

/**
 * Bound and flatten reporter-supplied free text before it lands in a finding a moderator reads.
 * Strips the markdown / masked-link structural characters, collapses all whitespace (newlines and
 * control characters included) to single spaces, and hard-caps the length. See `MAX_REPORTER_TEXT`
 * above for why each of those three is here.
 */
export function sanitizeReportReason(input: string): string {
  return input
    .replace(/[`[\]()*_~|>]/g, ' ') // markdown / masked-link structural chars
    // 🔴 `\s` is NOT a superset of "control character" — it misses U+0000-U+0008, U+000E-U+001F
    // and U+007F, every one of which is legal in a `text` column and renders as nothing or a box.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REPORTER_TEXT);
}

/** 🔴 A reason over the contract's limit does not lose the finding, it 400s the REPORT and loses
 *  every finding in the batch. Truncated here; the ellipsis is the record that something was cut. */
export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  return reason.length <= max ? reason : `${reason.slice(0, max - 1)}…`;
}

/**
 * 🔴 EVERYTHING THE MODERATOR NEEDS TO FIND THE ROW GOES IN THE REASON, AND NOTHING ELSE DOES.
 *
 * The board row is the only place a moderator is told what this is. It names the app, the block, the
 * row key and who reported it — enough to open the app's own moderation view and act — plus what the
 * reporters actually said, which is the part that distinguishes "harassment" from "this is a
 * duplicate". It does NOT carry the reported text: that is a deliberate omission, not an oversight,
 * and `reader.ts` cannot supply it even if this function asked.
 */
export function renderReason(row: ReportedRow): string {
  const reporters = row.reporterUserIds;
  const shownReporters = reporters.slice(0, MAX_REPORTERS_RENDERED);
  const reporterList =
    shownReporters.map((id) => `#${id}`).join(', ') +
    (reporters.length > shownReporters.length
      ? `, and ${reporters.length - shownReporters.length} more`
      : '');

  const quotes = row.reasons
    .map(sanitizeReportReason)
    .filter((r) => r.length > 0)
    .slice(0, MAX_REASONS_RENDERED);

  const parts = [
    `${reporters.length} user report(s) on shared-storage row ${row.key} in app "${row.slug}"${
      row.appBlockId ? ` (app block ${row.appBlockId})` : ''
    }.`,
    `Reported by user ${reporterList}.`,
    quotes.length
      ? `Stated reason(s): ${quotes.map((q) => `"${q}"`).join(' | ')}.`
      : 'No reason text was supplied.',
    row.hidden
      ? 'The reported row is ALREADY HIDDEN by a moderator — this may need no further action.'
      : 'The reported row is still visible in the app.',
    // Said on every row, because a moderator has no other way to know why the row they are about to
    // rule on does not show them the thing that was reported.
    'The reported content is deliberately not included here — open the app to review it.',
  ];
  return truncateReason(parts.join(' '));
}

/**
 * 🔴 CONFIDENCE IS THE QUEUE'S SORT ORDER, NOT A PROBABILITY.
 *
 * `getAbuseFindings` orders by `confidence DESC`, and a user report is an ALLEGATION — this producer
 * has run no rule and formed no opinion about whether the row is abusive, so a probability here
 * would be invented outright. What it does know is how many DISTINCT accounts independently flagged
 * the same row, which is the only ordering signal available and the one a moderator would use.
 *
 * A single report floors at 0.4 rather than at 0 so the rows stay visibly ranked rather than reading
 * as "the detector is 0% sure"; the band is deliberately narrow and coarse for the same reason the
 * sibling detectors' is — nobody should read the spread as meaning.
 */
export function confidenceFor(row: ReportedRow): number {
  const reporters = Math.max(1, row.reporterUserIds.length);
  return Math.round(Math.min(1, 0.4 + 0.15 * (reporters - 1)) * 100) / 100;
}

/**
 * 🔴 `actioned: false` IS A LITERAL, AND MUST STAY ONE. This sweep holds no write client: it reads
 * report rows and POSTs them. Nothing here hides a row, bans an author or resolves a report — a
 * moderator does that through `apps.mod.purgeSharedRow`. The contract also REJECTS the whole batch
 * when `actioned` is false and `action` is non-null, so `action` is absent by construction here.
 */
export function toFinding(row: ReportedRow): Finding {
  return {
    userId: row.authorUserId,
    confidence: confidenceFor(row),
    reason: renderReason(row),
    actioned: false,
  };
}

export function renderSummary(args: {
  rows: ReportedRow[];
  reports: number;
  unattributed: number;
  windowHours: number;
  apps: number;
  truncated: boolean;
}): string {
  const { rows, reports, unattributed, windowHours, apps, truncated } = args;
  if (!rows.length && !unattributed) {
    return `No user reports were filed on App Blocks shared storage in the last ${windowHours}h (${apps} app(s) with shared storage scanned).`;
  }
  const parts = [
    `${reports} user report(s) on ${rows.length} shared-storage row(s) across ${apps} app(s) in the last ${windowHours}h.`,
  ];
  if (unattributed)
    parts.push(
      `${unattributed} report(s) concern a row that no longer exists (purged or withdrawn), so they have no author to file against and are counted but not listed.`
    );
  if (truncated)
    parts.push(
      'THE SCAN BUDGET WAS REACHED — report rows in this window were NOT read by this run and are not on this page. Widen the budget or shorten the cadence.'
    );
  parts.push('Nothing was hidden, removed or actioned by this sweep.');
  return parts.join(' ');
}

export type BuildReportsArgs = {
  findings: Finding[];
  startedAt: Date;
  finishedAt: Date;
  summary: string;
  counters: Record<string, number>;
  maxFindingsPerReport?: number;
};

/**
 * Split a run's findings across as many reports as the contract's per-report cap needs.
 *
 * 🔴 TRUNCATING INSTEAD WOULD RE-OPEN THE HOLE THIS JOB CLOSES. A dropped finding is a user's abuse
 * report that nothing surfaces — the exact state the Discord webhook was bolted on to fix. So a run
 * that overflows files a second report rather than losing rows.
 *
 * The `+ index` ms on `startedAt` is what makes that legal: the board keys runs on
 * `(detector, started_at)`, so two reports sharing a timestamp collide on that unique index and the
 * second one 500s. Copied from `bot-account-detection/report.ts`, which hit exactly that.
 */
export function buildReports(args: BuildReportsArgs): AbuseReportInput[] {
  const size = args.maxFindingsPerReport ?? MAX_FINDINGS_PER_REPORT;
  const batches: Finding[][] = [];
  for (let i = 0; i < args.findings.length; i += size) batches.push(args.findings.slice(i, i + size));
  if (!batches.length) batches.push([]);

  return batches.map((batch, index) => {
    const startedAt = new Date(args.startedAt.getTime() + index);
    const finishedAt = new Date(Math.max(args.finishedAt.getTime(), startedAt.getTime()));
    return {
      detector: SHARED_STORAGE_REPORT_DETECTOR,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      summary:
        batches.length > 1
          ? `${args.summary} Batch ${index + 1} of ${batches.length}; ${batch.length} finding(s) in this report, ${args.findings.length} in the run.`
          : args.summary,
      counters:
        batches.length > 1
          ? {
              ...args.counters,
              batch_index: index + 1,
              batch_count: batches.length,
              batch_findings: batch.length,
            }
          : args.counters,
      findings: batch,
    };
  });
}

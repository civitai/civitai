import { describe, expect, it, vi } from 'vitest';
import { MAX_FINDINGS_PER_REPORT, abuseReportInput } from '@civitai/moderation';
import type { AbuseReportInput } from '@civitai/moderation';
import type { SharedReportReader, SharedReportRow } from '../reader';
import {
  MAX_REPORT_ROWS_SCANNED,
  SHARED_REPORT_WINDOW_HOURS,
  runSharedStorageReportSweep,
} from '../run';
import { SHARED_STORAGE_REPORT_DETECTOR, sanitizeReportReason } from '../report';

/**
 * What this suite is defending.
 *
 * The sweep exists because a user's abuse report used to land in a table nothing read. Two things
 * can put it back in that state without anything erroring: a report the board REFUSES (the contract
 * 400s the whole batch on one bad finding, so every report in the run is lost together), and a
 * finding that names the wrong person. And one thing can make it actively harmful: leaking the
 * reported CONTENT onto a board with a wider audience than the app's own moderation view.
 */

const NOW = new Date('2026-09-14T07:00:00.000Z');

function reportRow(over: Partial<SharedReportRow> = {}): SharedReportRow {
  return {
    id: 'skr_01',
    slug: 'ideas_board',
    appBlockId: 'apb_01KSD3NP23CQE4TMW14XTEFSNS',
    key: '01K5QF7Z0000000000000000AA',
    reporterUserId: 4242,
    reason: 'harassment — this is targeted at me',
    createdAt: new Date('2026-09-13T22:15:00.000Z'),
    authorUserId: 909,
    hidden: false,
    ...over,
  };
}

function readerReturning(
  rows: SharedReportRow[],
  over: { appsScanned?: number; appsFailed?: number; truncated?: boolean } = {}
): SharedReportReader & { calls: { since: Date; until: Date; limit: number }[] } {
  const calls: { since: Date; until: Date; limit: number }[] = [];
  return {
    calls,
    async listUserReports(args) {
      calls.push(args);
      return {
        rows,
        appsScanned: over.appsScanned ?? 3,
        appsFailed: over.appsFailed ?? 0,
        truncated: over.truncated ?? false,
      };
    },
  };
}

function sweep(reader: SharedReportReader | null, now: Date = NOW) {
  const sent: AbuseReportInput[] = [];
  const run = runSharedStorageReportSweep({
    reader,
    sendReport: async (report) => {
      sent.push(report);
    },
    now: () => now,
  });
  return { sent, run };
}

describe('the sweep files ONE well-formed run per window', () => {
  it('turns report rows into a single report the board contract accepts', async () => {
    const { sent, run } = sweep(readerReturning([reportRow()]));
    const result = await run;

    expect(sent).toHaveLength(1);
    // 🔴 THE ASSERTION THAT MATTERS. A finding the contract refuses does not lose one row, it 400s
    // the report and loses the whole run — which is the original "nothing reads these" state with a
    // job in front of it. Parsed against the REAL schema, not a shape assertion that would stay
    // green through `startedAt` losing its offset or `action` reappearing on a non-actioned finding.
    const parsed = abuseReportInput.parse(sent[0]);
    expect(parsed.detector).toBe(SHARED_STORAGE_REPORT_DETECTOR);
    expect(parsed.findings).toHaveLength(1);
    expect(result.rowsReported).toBe(1);
    expect(result.reports).toBe(1);
  });

  it('files a zero-finding run rather than nothing when there is nothing to report', async () => {
    // "This sweep ran and there was nothing to surface" and "this sweep has gone quiet" are
    // different claims, and only the first one can be made by filing.
    const { sent, run } = sweep(readerReturning([]));
    await run;
    expect(sent).toHaveLength(1);
    expect(abuseReportInput.parse(sent[0]).findings).toEqual([]);
    expect(sent[0].summary).toContain('No user reports');
  });

  it('never marks a finding actioned, and never sends an `action`', async () => {
    // The contract's `superRefine` REJECTS `actioned: false` with a non-null `action`, and rejects
    // the whole batch when it does. `actioned: true` would separately tell a moderator this row had
    // already been dealt with by a job that holds no write client at all.
    const { sent, run } = sweep(readerReturning([reportRow(), reportRow({ key: 'k2', id: 'skr_2' })]));
    await run;
    for (const finding of sent[0].findings) {
      expect(finding.actioned).toBe(false);
      expect(finding.action ?? null).toBeNull();
    }
    expect(() => abuseReportInput.parse(sent[0])).not.toThrow();
  });

  it('reads exactly the window the cron cadence covers', async () => {
    const reader = readerReturning([]);
    const { run } = sweep(reader);
    await run;

    const [call] = reader.calls;
    expect(call.until.getTime()).toBe(NOW.getTime());
    expect(NOW.getTime() - call.since.getTime()).toBe(SHARED_REPORT_WINDOW_HOURS * 60 * 60 * 1000);
    expect(call.limit).toBe(MAX_REPORT_ROWS_SCANNED);
  });

  it('skips — and files nothing — when the apps database is not configured', async () => {
    // PR previews / dev / legacy stage run without `APPS_DATABASE_URL`. Filing an empty run there
    // would put "nobody reported anything" on the board on the strength of never having looked.
    const { sent, run } = sweep(null);
    const result = await run;
    expect(sent).toHaveLength(0);
    expect(result.skipped).toBe('apps-db-unavailable');
  });
});

describe('🔴 the reported CONTENT never reaches the board', () => {
  /**
   * 🔴 WATCH THIS ONE FAIL BEFORE TRUSTING IT. Confirmed red by mapping the row's stored value into
   * the finding reason on purpose (`reason: \`${renderReason(row)} ${(row as any).value}\`` in
   * `report.ts`), which produced:
   *
   *   AssertionError: expected '…{"title":"CANARY-…"}' to not contain 'CANARY-8f2a1c-DO-NOT-LEAK'
   *
   * and went green again when the line was restored. The guard is reachable, and it fails for its
   * own reason rather than for a schema error.
   *
   * The fixture carries the content on the row deliberately — `SharedReportRow` has no field for it,
   * so a guard built only from the declared type would be asserting against something that cannot
   * exist and would pass for ever regardless of what the mapping did.
   */
  const SENTINEL = 'CANARY-8f2a1c-DO-NOT-LEAK';

  it('a stored value present on the source row appears NOWHERE in the serialised report', async () => {
    const withContent = {
      ...reportRow(),
      // The shape the real query deliberately does not select. Present here so the assertion has
      // something real to be wrong about.
      value: JSON.stringify({ title: SENTINEL, body: `${SENTINEL} in the body too` }),
      title: SENTINEL,
      body: SENTINEL,
    } as SharedReportRow;

    const { sent, run } = sweep(readerReturning([withContent]));
    await run;

    const serialised = JSON.stringify(sent);
    // Positive control on the probe: the sentinel IS in the input, so a serialiser that saw it would
    // have had the chance to emit it. Without this the assertion below could pass on an empty report.
    expect(JSON.stringify([withContent])).toContain(SENTINEL);
    expect(sent[0].findings).toHaveLength(1);

    expect(serialised).not.toContain(SENTINEL);
  });

  it('a reporter who pastes content into their REASON is bounded, not silently dropped', async () => {
    // The reporter's own words are the one free-text field that legitimately reaches the board —
    // that is what tells a moderator harassment from a duplicate. It is hostile-authored, so it is
    // flattened and capped; it is not censored, because then the row says nothing.
    const hostile = `click [here](https://phish.example) \`rm -rf\` **bold**\n\nsecond line`;
    const { sent, run } = sweep(readerReturning([reportRow({ reason: hostile })]));
    await run;

    // Asserted on the SANITISED QUOTE, not on the whole reason: the rendered sentence legitimately
    // contains parentheses of its own ("N user report(s)", "(app block …)"), so a char-ban over the
    // whole string would be asserting against this file's own prose rather than against the input.
    const quoted = sanitizeReportReason(hostile);
    for (const ch of ['[', ']', '(', ')', '`', '*', '_', '~', '|', '>']) {
      expect(quoted).not.toContain(ch);
    }
    expect(quoted).not.toMatch(/\s{2,}|\n/);
    expect(quoted).toContain('here'); // the words survive as inert text

    const { reason } = sent[0].findings[0];
    expect(reason).toContain(quoted); // …and that is what actually reached the board
    expect(reason).not.toMatch(/\]\(/); // the masked-link sequence specifically
    expect(reason).not.toContain('`');
    expect(reason).not.toMatch(/\n/);
    expect(reason.length).toBeLessThanOrEqual(2_000);
    expect(() => abuseReportInput.parse(sent[0])).not.toThrow();
  });

  it('a 100k-char reason cannot 400 the report and take every other finding with it', async () => {
    const { sent, run } = sweep(
      readerReturning([
        reportRow({ reason: 'x'.repeat(100_000) }),
        reportRow({ id: 'skr_2', key: 'k2', reason: 'spam' }),
      ])
    );
    await run;
    expect(() => abuseReportInput.parse(sent[0])).not.toThrow();
    expect(sent[0].findings).toHaveLength(2);
    expect(sanitizeReportReason('x'.repeat(100_000)).length).toBe(500);
  });
});

describe('who the finding is about', () => {
  it('🔴 names the AUTHOR of the reported row, never the reporter', async () => {
    // `abuseFinding.userId` is "the account the finding is ABOUT. Not an actor." Filing the reporter
    // would put the person who flagged the abuse into the moderator queue as its subject — a
    // silent, and actively harmful, inversion that no schema check can catch.
    const { sent, run } = sweep(
      readerReturning([reportRow({ authorUserId: 909, reporterUserId: 4242 })])
    );
    await run;
    expect(sent[0].findings[0].userId).toBe(909);
    expect(sent[0].findings[0].userId).not.toBe(4242);
    // The reporter is still on the row, as metadata in the reason.
    expect(sent[0].findings[0].reason).toContain('#4242');
  });

  it('counts — and does not invent a subject for — a report whose row is gone', async () => {
    const { sent, run } = sweep(
      readerReturning([
        reportRow({ id: 'skr_gone', key: 'purged', authorUserId: null }),
        reportRow(),
      ])
    );
    const result = await run;

    expect(result.unattributed).toBe(1);
    expect(sent[0].findings).toHaveLength(1);
    expect(sent[0].findings[0].userId).toBe(909);
    expect(sent[0].counters?.unattributed_reports).toBe(1);
    expect(sent[0].summary).toContain('no longer exists');
  });
});

describe('several reports of one row are ONE decision', () => {
  it('collapses to a single finding whose confidence rises with distinct reporters', async () => {
    const one = sweep(readerReturning([reportRow()]));
    await one.run;

    const many = sweep(
      readerReturning([
        reportRow({ id: 'a', reporterUserId: 1 }),
        reportRow({ id: 'b', reporterUserId: 2 }),
        reportRow({ id: 'c', reporterUserId: 3 }),
      ])
    );
    const result = await many.run;

    expect(many.sent[0].findings).toHaveLength(1);
    expect(result.rowsReported).toBe(1);
    expect(result.scanned).toBe(3);
    expect(many.sent[0].findings[0].confidence).toBeGreaterThan(one.sent[0].findings[0].confidence);
    expect(many.sent[0].findings[0].reason).toContain('3 user report(s)');
  });

  it('a duplicate reporter does not inflate the row up the queue', async () => {
    // The write site dedupes per (reporter, key), but READ COMMITTED admits a true double-submit.
    const dup = sweep(
      readerReturning([
        reportRow({ id: 'a', reporterUserId: 1 }),
        reportRow({ id: 'b', reporterUserId: 1 }),
      ])
    );
    await dup.run;
    const single = sweep(readerReturning([reportRow({ id: 'a', reporterUserId: 1 })]));
    await single.run;

    expect(dup.sent[0].findings[0].confidence).toBe(single.sent[0].findings[0].confidence);
    expect(dup.sent[0].findings[0].reason).toContain('1 user report(s)');
  });

  it('keeps two apps that happen to share a row key apart', async () => {
    const { sent, run } = sweep(
      readerReturning([
        reportRow({ id: 'a', slug: 'app_one', key: 'same', authorUserId: 11 }),
        reportRow({ id: 'b', slug: 'app_two', key: 'same', authorUserId: 22 }),
      ])
    );
    await run;
    expect(sent[0].findings.map((f) => f.userId).sort()).toEqual([11, 22]);
  });

  it('says so, loudly, when the scan budget cut the window short', async () => {
    const { sent, run } = sweep(readerReturning([reportRow()], { truncated: true }));
    const result = await run;
    expect(result.truncated).toBe(true);
    expect(sent[0].counters?.scan_truncated).toBe(1);
    expect(sent[0].summary).toContain('SCAN BUDGET');
  });
});

describe('a run bigger than one report', () => {
  it('splits rather than truncating, with timestamps the board can key on', async () => {
    // 🔴 Dropping the overflow would be the original hole with extra steps: a user's abuse report
    // that nothing surfaces. And two reports sharing a `startedAt` collide on the board's
    // `(detector, started_at)` unique index, so the second one 500s and IS dropped.
    const rows = Array.from({ length: MAX_FINDINGS_PER_REPORT + 5 }, (_, i) =>
      reportRow({ id: `skr_${i}`, key: `key_${i}`, authorUserId: i + 1 })
    );
    const { sent, run } = sweep(readerReturning(rows));
    const result = await run;

    expect(result.reports).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[0].findings).toHaveLength(MAX_FINDINGS_PER_REPORT);
    expect(sent[1].findings).toHaveLength(5);
    expect(sent[0].startedAt).not.toBe(sent[1].startedAt);
    for (const report of sent) expect(() => abuseReportInput.parse(report)).not.toThrow();
  });
});

describe('the run reports what it did', () => {
  it('logs the counters a reader needs to tell "found nothing" from "looked at nothing"', async () => {
    const log = vi.fn();
    await runSharedStorageReportSweep({
      reader: readerReturning([reportRow()], { appsScanned: 7, appsFailed: 2 }),
      sendReport: async () => undefined,
      now: () => NOW,
      log,
    });
    expect(log).toHaveBeenCalledWith(
      'shared-storage-report-sweep-reported',
      expect.objectContaining({ apps_scanned: 7, apps_failed: 2, reports_scanned: 1 })
    );
  });
});

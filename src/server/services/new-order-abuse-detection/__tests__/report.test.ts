import { describe, expect, it } from 'vitest';
import { MAX_REASON_LENGTH, abuseReportInput } from '@civitai/moderation';
import {
  ABUSE_SCAN_WINDOW_HOURS,
  NEW_ORDER_ABUSE_DETECTOR,
  SMITE_ACTION,
  buildAbuseReport,
  confidenceFor,
  renderReason,
  renderSummary,
  toFinding,
  truncateReason,
  type AbuseSuspect,
} from '../report';

/**
 * Three properties here fail silently, and each one fails in the direction of a moderator trusting a
 * page that is wrong.
 *
 * A finding that omits the numbers the rule used renders as a bare accusation the reviewer cannot
 * check. A finding whose `actioned`/`action` pair is half-set is refused by the contract on the
 * PRODUCER's side of the wire, which loses the whole batch — every correctly-built finding beside it
 * included — so the board shows nothing at all rather than showing something wrong. And a threshold
 * leaking into `counters` puts a tunable on a page that has no use for one.
 *
 * ⚠️ That last guard is about proportionality, NOT secrecy — the observed values on the findings
 * already bound the thresholds, and the header of `../report` says how. The key set is pinned anyway
 * so that adding a threshold counter is a decision someone made, not an accident nobody saw.
 */

const suspect = (overrides: Partial<AbuseSuspect> = {}): AbuseSuspect => ({
  userId: 100,
  totalRatings: 200,
  uniqueRatings: 1,
  dominantRating: 3,
  dominantPct: 100,
  avgPerMinute: 5,
  ...overrides,
});

describe('renderReason', () => {
  it('states all six columns the query selected', () => {
    // 🔴 The contract has NO structured-metrics field, so if a number is not in this sentence it is
    // nowhere on the board. Every field of the query row is asserted individually — an assertion on
    // the whole string would pass on a template that silently dropped one and kept the rest.
    const reason = renderReason(
      suspect({
        userId: 4242,
        totalRatings: 1_500,
        uniqueRatings: 2,
        dominantRating: 5,
        dominantPct: 87.4,
        avgPerMinute: 12.36,
      }),
      false
    );

    expect(reason).toContain('4242'); // userId
    expect(reason).toContain('1,500'); // totalRatings
    expect(reason).toContain('2 distinct rating value(s)'); // uniqueRatings
    expect(reason).toContain('the value 5'); // dominantRating
    expect(reason).toContain('87%'); // dominantPct
    expect(reason).toContain('12.4 rating(s) per active minute'); // avgPerMinute
    expect(reason).toContain(`last ${ABUSE_SCAN_WINDOW_HOURS}h`);
  });

  it('floors the dominant share rather than rounding it up to a stronger claim', () => {
    // 99.6% rounding to "100%" asserts that EVERY rating was the same value. A moderator acts on
    // that sentence, so it has to be literally true.
    expect(renderReason(suspect({ dominantPct: 99.6 }), false)).toContain('99%');
    expect(renderReason(suspect({ dominantPct: 99.6 }), false)).not.toContain('100%');
  });

  it('says what was done, matching the actioned flag on the same row', () => {
    expect(renderReason(suspect(), true)).toContain('Auto-smited');
    const open = renderReason(suspect(), false);
    expect(open).toContain('No action was taken');
    expect(open).not.toContain('Auto-smited');
  });
});

describe('truncateReason', () => {
  it('trims against the CONTRACT’s bound, not a local copy of it', () => {
    // 🔴 The cap the producer trims to and the cap the parser enforces must be ONE number. They were
    // two literals in two packages, which drift silently and in both damaging directions — trimming
    // to a length the parser already rejects, or not trimming where it would have. The value is
    // pinned as well as the identifier, so lowering the contract's bound is a deliberate act that
    // shows up here rather than a silent re-interpretation of every producer's truncation.
    expect(MAX_REASON_LENGTH).toBe(2_000);
    expect(truncateReason('a'.repeat(MAX_REASON_LENGTH))).toHaveLength(MAX_REASON_LENGTH);
    const cut = truncateReason('a'.repeat(MAX_REASON_LENGTH + 1));
    expect(cut).toHaveLength(MAX_REASON_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('is defence in depth: the generated reason cannot reach the cap on any input', () => {
    // ⚠️ This records HEADROOM, not a save. Every numeric field at `Number.MAX_SAFE_INTEGER` — NOT
    // a ceiling on anything ClickHouse can hand us (`JSON.parse` yields a double, and a `UInt64`
    // exceeds this by ~2,000x), just an absurdly large input that is still a number — renders 269
    // characters smited and 311 open, against a cap of 2,000, and a realistic finding is ~220. A
    // larger magnitude would not move that much: these render through `toLocaleString`/`toFixed`, so
    // the length grows with the DIGIT COUNT, and the headroom below absorbs several more digits. So
    // `truncateReason` has never trimmed anything
    // and cannot with this template; it guards a future one that interpolates an unbounded string.
    // Asserted against a quarter of the cap rather than the cap, which a 6x longer template clears.
    const absurd = suspect({
      userId: Number.MAX_SAFE_INTEGER,
      totalRatings: Number.MAX_SAFE_INTEGER,
      uniqueRatings: Number.MAX_SAFE_INTEGER,
      dominantRating: Number.MAX_SAFE_INTEGER,
      dominantPct: Number.MAX_SAFE_INTEGER,
      avgPerMinute: Number.MAX_SAFE_INTEGER,
    });
    for (const smited of [true, false]) {
      const reason = renderReason(absurd, smited);
      expect(reason.length).toBeLessThan(MAX_REASON_LENGTH / 4);
      expect(reason.endsWith('…')).toBe(false); // nothing was cut
    }
    expect(abuseReportInput.safeParse(reportOf([suspect()], new Set([100]))).success).toBe(true);
  });
});

describe('confidenceFor', () => {
  it('stays inside the band the board sorts on', () => {
    const extremes = [
      suspect({ uniqueRatings: 1, dominantPct: 100, totalRatings: 10_000 }),
      suspect({ uniqueRatings: 20, dominantPct: 0, totalRatings: 0 }),
      suspect({ uniqueRatings: 0, dominantPct: 150, totalRatings: -5 }),
    ];
    for (const s of extremes) {
      const c = confidenceFor(s);
      expect(c).toBeGreaterThanOrEqual(0.5);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a single-value spammer above a varied heavy voter', () => {
    const scripted = suspect({ uniqueRatings: 1, dominantPct: 100, totalRatings: 200 });
    const human = suspect({ uniqueRatings: 5, dominantPct: 40, totalRatings: 200 });
    expect(confidenceFor(scripted)).toBeGreaterThan(confidenceFor(human));
  });

  it('does not restate the Acted column — it is not a function of `actioned`', () => {
    // 🔴 If confidence moved with the smite outcome, the sort order would rank the rows a moderator
    // has NOTHING left to do on above the ones they have to triage.
    const s = suspect();
    expect(toFinding(s, true).confidence).toBe(toFinding(s, false).confidence);
  });
});

/**
 * 🔴 THE REGRESSION GUARD. The contract's `superRefine` refuses BOTH halves of the wrong pairing —
 * `actioned: true` with no `action`, and `actioned: false` with one — and `moderatorApp.abuseReport`
 * parses before the network call, so a single mispaired finding throws and the entire run, including
 * every correct finding beside it, never reaches the board.
 *
 * Both directions are asserted, and the payload is then parsed, because the two checks catch
 * different mistakes: the field assertions catch a mapping that is inverted, and the parse catches a
 * mapping that is merely inconsistent with the schema the fields will be judged by.
 */
describe('actioned/action pairing', () => {
  it('marks an auto-smited suspect actioned, naming the action', () => {
    const finding = toFinding(suspect({ userId: 111 }), true);
    expect(finding.actioned).toBe(true);
    expect(finding.action).toBe(SMITE_ACTION);
    expect(SMITE_ACTION).toBe('smite');
  });

  it('marks a non-smited suspect not-actioned, with no action key at all', () => {
    const finding = toFinding(suspect({ userId: 222 }), false);
    expect(finding.actioned).toBe(false);
    // `not.toHaveProperty`, not `toBeUndefined`: the contract accepts an absent key AND an explicit
    // null, so omitting it is what makes the forbidden combination unrepresentable rather than
    // merely unset. `toBeUndefined` would pass on `action: undefined`, which is a field that exists.
    expect(finding).not.toHaveProperty('action');
  });

  it('files a mixed run — one smited, one not — as a payload the contract accepts', () => {
    const smited = suspect({ userId: 111, uniqueRatings: 1, dominantPct: 100 });
    const open = suspect({ userId: 222, uniqueRatings: 4, dominantPct: 55, avgPerMinute: 30 });

    const report = reportOf([smited, open], new Set([111]));
    const parsed = abuseReportInput.safeParse(report);

    // The whole point: a mispaired finding makes THIS false, and the board gets nothing.
    expect(parsed.success).toBe(true);
    expect(report.findings.map((f) => [f.userId, f.actioned, f.action])).toEqual([
      [111, true, 'smite'],
      [222, false, undefined],
    ]);
  });

  it('parses each direction on its own, so one arm cannot mask the other', () => {
    expect(abuseReportInput.safeParse(reportOf([suspect()], new Set([100]))).success).toBe(true);
    expect(abuseReportInput.safeParse(reportOf([suspect()], new Set())).success).toBe(true);
  });

  it('refuses the inverted pairing — the negative control on the contract itself', () => {
    // 🔴 THE FINDINGS HERE ARE WRITTEN OUT IN FULL, NOT SPREAD OVER A `toFinding` RESULT. A control
    // built from the function under test is a second sample of it, not a control: with the mapping
    // inverted, spreading `{ actioned: true }` over a non-smited finding would inherit that
    // finding's `action: 'smite'` and parse CLEANLY — so the control would go red for the mutant's
    // reason instead of staying green and proving the contract still refuses the pair. Measured:
    // that is exactly what the earlier version of this case did.
    const envelope = {
      detector: NEW_ORDER_ABUSE_DETECTOR,
      startedAt: '2026-09-14T23:00:00.000Z',
      finishedAt: '2026-09-14T23:00:42.000Z',
      summary: null,
      counters: null,
    };
    const valid = { userId: 100, confidence: 0.9, reason: 'evidence' };

    expect(abuseReportInput.safeParse({ ...envelope, findings: [valid] }).success).toBe(false);
    expect(
      abuseReportInput.safeParse({ ...envelope, findings: [{ ...valid, actioned: true }] }).success
    ).toBe(false);
    expect(
      abuseReportInput.safeParse({
        ...envelope,
        findings: [{ ...valid, actioned: false, action: SMITE_ACTION }],
      }).success
    ).toBe(false);
    // The positive control on this instrument: the same envelope with a correctly-paired finding
    // MUST parse, or the three refusals above prove nothing about the pair specifically.
    expect(
      abuseReportInput.safeParse({
        ...envelope,
        findings: [
          { ...valid, actioned: true, action: SMITE_ACTION },
          { ...valid, userId: 101, actioned: false },
        ],
      }).success
    ).toBe(true);
  });
});

describe('buildAbuseReport', () => {
  it('stamps the producer key and ISO timestamps the contract accepts', () => {
    const report = reportOf([suspect()], new Set());
    expect(report.detector).toBe(NEW_ORDER_ABUSE_DETECTOR);
    // 🔴 `isoWithOffset`, not the bare `.datetime()` — but a `Z` string must still pass, because
    // that is what `Date.prototype.toISOString` emits and it is the only producer clock here.
    expect(report.startedAt).toMatch(/Z$/);
    expect(abuseReportInput.safeParse(report).success).toBe(true);
  });

  it('floors finishedAt at startedAt rather than losing the run to a backwards clock', () => {
    const report = buildAbuseReport({
      suspects: [suspect()],
      smitedUserIds: new Set(),
      startedAt: new Date('2026-09-14T23:00:05Z'),
      finishedAt: new Date('2026-09-14T23:00:00Z'),
    });
    expect(report.finishedAt).toBe('2026-09-14T23:00:05.000Z');
    expect(abuseReportInput.safeParse(report).success).toBe(true);
  });

  it('files a run with no suspects rather than staying silent', () => {
    // "No report today" and "a report with zero findings" look the same to a reader otherwise, and
    // the first is what a BROKEN producer looks like.
    const report = reportOf([], new Set());
    expect(report.findings).toEqual([]);
    expect(report.counters).toMatchObject({ suspects: 0, auto_smited: 0, filed_for_review: 0 });
    expect(report.summary).toContain('No accounts matched');
    expect(abuseReportInput.safeParse(report).success).toBe(true);
  });

  it('counts the accounts actually smited, not the ones named in the set', () => {
    // A stale id in the set — an account that dropped out of the cohort — must not inflate the
    // "already dealt with" figure a moderator reads off the summary.
    const report = reportOf([suspect({ userId: 1 }), suspect({ userId: 2 })], new Set([2, 999]));
    expect(report.counters).toMatchObject({ suspects: 2, auto_smited: 1, filed_for_review: 1 });
    expect(report.summary).toContain('1 were auto-smited');
  });

  it('publishes no threshold in counters', () => {
    // 🔴 A counter is a wider and longer-lived disclosure than a log line, and no threshold belongs
    // on a page with no use for one. ⚠️ This does not make the thresholds unrecoverable — the
    // observed values on the findings bound them; see the header of `../report`. Pinned as the WHOLE
    // key set,
    // not as an absence check: a check that only forbids today's threshold names cannot see a new
    // one being added, and the failure would be a leak rather than a red test.
    const report = reportOf([suspect()], new Set([100]));
    expect(Object.keys(report.counters ?? {}).sort()).toEqual([
      'auto_smited',
      'filed_for_review',
      'lookback_hours',
      'suspects',
    ]);
  });
});

describe('renderSummary', () => {
  it('splits the cohort into acted-on and waiting', () => {
    const summary = renderSummary(
      [suspect({ userId: 1, totalRatings: 10 }), suspect({ userId: 2, totalRatings: 5 })],
      1
    );
    expect(summary).toContain('2 account(s)');
    expect(summary).toContain('15 rating(s)');
    expect(summary).toContain('1 were auto-smited');
    expect(summary).toContain('1 were filed for review');
  });
});

/** The report a real run would build, at a fixed clock. */
function reportOf(suspects: AbuseSuspect[], smitedUserIds: Set<number>) {
  return buildAbuseReport({
    suspects,
    smitedUserIds,
    startedAt: new Date('2026-09-14T23:00:00Z'),
    finishedAt: new Date('2026-09-14T23:00:42Z'),
  });
}

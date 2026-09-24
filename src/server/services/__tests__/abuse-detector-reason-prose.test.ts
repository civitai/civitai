import { describe, expect, it } from 'vitest';
import type { AbuseReportInput } from '@civitai/moderation';
import { runBotAccountDetection } from '~/server/services/bot-account-detection/run';
import {
  buildFinding,
  renderPostCounts,
  POST_COUNT_LEGEND,
} from '~/server/services/bot-account-detection/report';
import type {
  BotAccountCohortMember,
  CohortReader,
  NewAccountRow,
  PostCounts,
  SurfaceCounts,
} from '~/server/services/bot-account-detection/cohort';
import type { BotAccountScore } from '~/server/services/bot-account-detection/scoring';
import {
  renderReason,
  renderSummary,
  type AbuseSuspect,
} from '~/server/services/new-order-abuse-detection/report';
import { NO_ACTION_TAKEN, plural } from '~/server/services/abuse-report-prose';

/**
 * 🔴 THE MODERATOR-FACING `reason` MUST NOT LEAK THE IMPLEMENTATION THAT PRODUCED IT.
 *
 * The wire contract calls `reason` "the whole value of the row to a moderator" — it is the sentence
 * a non-technical person reads to decide whether an account is abusive, and it is the only free text
 * a finding carries. Detector code is written by people fluent in the identifiers, so the leak is
 * cheap to make and invisible to the person who made it: `bot-account-detection` ended every finding
 * with `Per-heuristic: posting-velocity=0.00, registration-cluster=0.00, content-templating=1.00,
 * asset-staging=1.00. Blended confidence 0.50.` for its whole life, and no test noticed because
 * every test was written by someone who could read it.
 *
 * So this gate asserts the two shapes that leak, over the strings the two IN-REPO producers actually
 * emit:
 *
 *   1. a camelCase identifier (`coCryShare`, `lifeSpanSec`) sitting in the prose;
 *   2. an `identifier=<number>` pair, which is a debug dump however it is spelled.
 *
 * 🔴 SCOPE — TWO PRODUCERS, NAMED, BY IMPORT, AND THAT IS NARROWER THAN "THIS REPO'S PRODUCERS".
 * `src/server/services` holds THREE abuse-report producers — `bot-account-detection`,
 * `new-order-abuse-detection` and `reaction-withdrawal-detection` — and more detectors post to this
 * board from outside the repo entirely. This gate covers the first two. The third is deliberately
 * excluded: its reason carries `day(s)`/`account(s)` and no non-action sentence at all
 * (`reaction-withdrawal-detection/report.ts`), so including it would make this permanently red, and
 * a gate nobody can make green is worse than no gate because it trains everyone to click through.
 * Bringing it in means fixing its prose first, in a change that reviews that detector.
 *
 * The two in scope are reached by IMPORT rather than by scanning a directory, so the set cannot grow
 * by accident — a new producer directory does not silently join and turn this red.
 *
 * ⚠️ WHAT IT CANNOT SEE — three gaps, named rather than implied:
 *
 *  1. THE RUN SUMMARY IS NOT CHECKED, and it leaks in a shape these regexes could not see anyway.
 *     `run.ts` writes `confidence_bucket_*` and `evidence_source_read_failures` verbatim into the
 *     summary a moderator reads above the findings table — snake_case identifiers, so neither
 *     `CAMEL_CASE` nor `ASSIGNMENT` matches them. That is a real instance of this gate's own hazard
 *     in a string it does not read. Fixing it means rewording those disclosure sentences, which is
 *     a change to what the summary SAYS rather than to how a finding reads, and it is left out
 *     rather than half-done.
 *  2. USER CONTENT IS EXCLUDED BY DECLARATION. A camelCase username or filename flows into the
 *     reason verbatim; that is data, not a prose defect. `stripUserText` blanks declared spans, and
 *     the cases below prove both that it works and that it is not a blanket escape.
 *  3. IT CHECKS THE TEMPLATE, NOT A RUN. Fixtures stand in for production data — but the
 *     end-to-end case below runs the real detector over the real heuristic registry, so the
 *     `explain()` output that lands in `Signals —` is the genuine article rather than a hand-copy.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A camelCase boundary: a lowercase letter immediately followed by an uppercase one.
 *
 * Deliberately NOT anchored to a whole token, because the leak is the boundary itself and a
 * whole-token pattern has to guess where an identifier ends. Hyphenated names are NOT matched —
 * `content-templating` has no such boundary — which matters because the heuristics' notes name them
 * in prose on purpose and must stay legal.
 */
const CAMEL_CASE = /[a-z][A-Z]/;

/**
 * `name=0.00`. `[\w-]+` so a hyphenated heuristic id is caught too — the dump this gate was written
 * for spelled its keys that way, and a pattern that only saw `\w+` would have matched the tail
 * (`velocity=0.00`) rather than the whole pair, which still fires but reports confusingly.
 *
 * The `=` is the whole signal: a hyphenated name in prose is fine, the same name with a number
 * assigned to it is a debug line. Whitespace is admitted around the `=` so a reformat cannot walk it.
 */
const ASSIGNMENT = /[\w-]+\s*=\s*[\d.]+/;

/** What a blanked span is replaced WITH — a marker rather than nothing, so the words either side of
 *  it stay separate tokens instead of being joined into a new one. */
const USER_TEXT_MARKER = '‹user-text›';

/**
 * Blank out spans that came from USER-SUPPLIED data before checking.
 *
 * 🔴 WITHOUT THIS THE GATE WOULD FAIL ON CORRECT PROSE. Three values flow into a reason verbatim: an
 * account's username, the email domain of a cluster, and the filename a ring shared (quoted into
 * `content-templating`'s note). A person may legitimately be called `myCoolName` and upload
 * `myCoolPic.png`, and neither is a prose defect — the gate's subject is the words THIS REPO wrote.
 *
 * The literals are declared by the caller rather than inferred, so blanking cannot silently widen:
 * a value the fixture did not declare is checked like any other text. Occurrences are replaced with
 * a neutral marker, not deleted, so the surrounding sentence still reads as separate words.
 */
function stripUserText(reason: string, userText: readonly string[]): string {
  let out = reason;
  for (const literal of userText) {
    // 🔴 A SHORT OR COMMON LITERAL WOULD BLANK PROSE, NOT DATA, AND THE GATE WOULD GO GREEN FOR THE
    // WRONG REASON. This is a global substring replace with no position guard: a fixture whose
    // username happened to be `on`, `item` or `Signals` would delete those words everywhere they
    // appear, including out of the sentences this file exists to police. Refusing the input is the
    // cheap fix — every real declared literal here is a username or a filename, both comfortably
    // over the floor, and a future fixture that trips this wants a human deciding, not a silent
    // pass.
    if (literal.length < 4)
      throw new Error(
        `user-text literal ${JSON.stringify(literal)} is too short to blank safely — it would ` +
          `remove ordinary prose from the checked string and make this gate pass vacuously`
      );
    const occurrences = out.split(literal).length - 1;
    if (occurrences > 4)
      throw new Error(
        `user-text literal ${JSON.stringify(literal)} appears ${occurrences} times — that is a ` +
          `substring of the prose, not an interpolated value`
      );
    out = out.split(literal).join(USER_TEXT_MARKER);
  }
  return out;
}

/** The gate itself. Returns the offending fragment, or `null` when the prose is clean. */
function prosePolice(
  reason: string,
  userText: readonly string[] = []
): { rule: 'camelCase' | 'assignment'; match: string } | null {
  const text = stripUserText(reason, userText);
  const camel = CAMEL_CASE.exec(text);
  if (camel) {
    // Report the whole word around the boundary, so a failure names something greppable.
    const word = /[A-Za-z]*[a-z][A-Z][A-Za-z]*/.exec(text);
    return { rule: 'camelCase', match: word ? word[0] : camel[0] };
  }
  const assigned = ASSIGNMENT.exec(text);
  if (assigned) return { rule: 'assignment', match: assigned[0] };
  return null;
}

/** The assertion, so every call site reports the same way. */
const expectCleanProse = (reason: string, userText: readonly string[] = []) =>
  expect(
    prosePolice(reason, userText),
    `moderator-facing reason leaks implementation vocabulary:\n  ${reason}`
  ).toBeNull();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — the real builders, not hand-written strings
// ─────────────────────────────────────────────────────────────────────────────

const AT = (iso: string) => new Date(iso);
const SCAN = AT('2026-09-03T03:20:00.000Z');

const surface = (partial: Partial<SurfaceCounts> = {}): SurfaceCounts => {
  const row = { comments: 0, models: 0, images: 0, ...partial };
  return { ...row, total: row.comments + row.models + row.images };
};

const posts = (all: Partial<SurfaceCounts>, visible: Partial<SurfaceCounts> = all): PostCounts => {
  const a = surface(all);
  const v = surface(visible);
  return {
    all: a,
    visible: v,
    excluded: {
      comments: Math.max(0, a.comments - v.comments),
      models: Math.max(0, a.models - v.models),
      images: Math.max(0, a.images - v.images),
      total: Math.max(0, a.total - v.total),
    },
  };
};

const member = (overrides: Partial<BotAccountCohortMember> = {}): BotAccountCohortMember => ({
  userId: 91,
  username: 'newcomer',
  createdAt: AT('2026-09-03T00:20:00.000Z'),
  posts: posts({ comments: 2, models: 1, images: 3 }),
  emailDomain: 'newcomer.test',
  ...overrides,
});

/**
 * Sub-scores carrying REAL note text, copied from the heuristics' own `explain` output.
 *
 * The notes are the one part of the scoring that still reaches the sentence, so a gate run over
 * findings whose notes were all `null` would be checking a template with its most dangerous clause
 * missing — the positive-control case below asserts the notes are present for exactly that reason.
 */
const score = (overrides: Partial<BotAccountScore> = {}): BotAccountScore => ({
  userId: 91,
  confidence: 0.25,
  subScores: [
    {
      id: 'registration-cluster',
      score: 0.5,
      weight: 1,
      note: '6 new posting accounts share its registration IP',
      clamped: false,
    },
    {
      id: 'content-templating',
      score: 0.5,
      weight: 1,
      note: '6 new accounts uploaded a file with the same name — “logo.jpg”',
      clamped: false,
    },
    {
      id: 'posting-velocity',
      score: 0.25,
      weight: 1,
      note: 'posted 8 items in 1.0h — 8.0/hour (scores above 4/hour)',
      clamped: false,
    },
    { id: 'asset-staging', score: 0, weight: 1, note: null, clamped: false },
  ],
  ...overrides,
});

const suspect = (overrides: Partial<AbuseSuspect> = {}): AbuseSuspect => ({
  userId: 100,
  totalRatings: 591,
  uniqueRatings: 5,
  dominantRating: 1,
  dominantPct: 35,
  avgPerMinute: 16,
  ...overrides,
});

/** Every moderator-facing string the two in-scope producers mint, with its user-supplied spans. */
const inScopeReasons = (): { label: string; text: string; userText: string[] }[] => [
  {
    label: 'bot-account-detection — signals fired, content still up',
    text: buildFinding(member(), score(), SCAN).reason,
    userText: ['newcomer', 'logo.jpg'],
  },
  {
    label: 'bot-account-detection — nothing fired, content taken down',
    text: buildFinding(
      member({ posts: posts({ images: 40 }, {}) }),
      score({ subScores: score().subScores.map((s) => ({ ...s, score: 0, note: null })) }),
      SCAN
    ).reason,
    userText: ['newcomer'],
  },
  {
    label: 'bot-account-detection — one of everything, singular forms',
    text: buildFinding(
      member({ posts: posts({ comments: 1, models: 1, images: 1 }) }),
      score(),
      SCAN
    ).reason,
    userText: ['newcomer', 'logo.jpg'],
  },
  {
    label: 'bot-account-detection — no username',
    text: buildFinding(member({ username: null }), score(), SCAN).reason,
    userText: ['logo.jpg'],
  },
  {
    label: 'new-order-abuse-detection — filed, not actioned',
    text: renderReason(suspect(), false),
    userText: [],
  },
  {
    label: 'new-order-abuse-detection — auto-smited',
    text: renderReason(suspect(), true),
    userText: [],
  },
  {
    label: 'new-order-abuse-detection — singular everything',
    text: renderReason(suspect({ totalRatings: 1, uniqueRatings: 1, avgPerMinute: 1 }), false),
    userText: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Controls first. A gate nobody has watched fail is a claim about a regex.
// ─────────────────────────────────────────────────────────────────────────────

describe('the gate itself — validated before any verdict is read off it', () => {
  it('🔴 NEGATIVE CONTROL — it goes red on the real shape it was written for', () => {
    // Built from the two leaks actually observed on this board: a camelCase field name from one of
    // the out-of-repo detectors, and the `id=0.00` dump this repo's own producer shipped. Realistic
    // data, not a textbook fixture — a check that only fires on `fooBar=1` is testing itself.
    const leaky =
      'Account 4242 coCryShare 0.92 over lifeSpanSec 240. ' +
      'Per-heuristic: posting-velocity=0.00, registration-cluster=0.00, ' +
      'content-templating=1.00, asset-staging=1.00. Blended confidence 0.50.';

    const verdict = prosePolice(leaky);
    expect(verdict).not.toBeNull();
    expect(verdict?.rule).toBe('camelCase');
    expect(verdict?.match).toBe('coCryShare');

    // And each rule fires on its OWN half, so a green run of the pair cannot be one rule carrying
    // both. Without this split, deleting `ASSIGNMENT` entirely would leave this case passing.
    expect(prosePolice('coCryShare 0.92 over lifeSpanSec 240.')?.rule).toBe('camelCase');
    const dump = prosePolice(
      'Per-heuristic: posting-velocity=0.00, registration-cluster=0.00, asset-staging=1.00.'
    );
    expect(dump?.rule).toBe('assignment');
    expect(dump?.match).toBe('posting-velocity=0.00');
  });

  it('🔴 it does NOT fire on the legitimate content it sits next to', () => {
    // A hyphenated heuristic name in prose is the whole point of the notes clause and must stay
    // legal. If this went red the gate would be unusable on the very strings it guards.
    expect(
      prosePolice(
        'Signals — content-templating: 6 new accounts uploaded a file with the same name. ' +
          'registration-cluster: 6 new posting accounts share its registration IP.'
      )
    ).toBeNull();
    // A bare decimal, a rate, a percentage and an ISO instant are all ordinary in these sentences.
    expect(
      prosePolice(
        'registered 2026-09-03T00:20:00.000Z, 3.0h old at scan. 87% of them were the value 5. ' +
          'Pace 16.0 ratings per active minute. 8.0/hour (scores above 4/hour).'
      )
    ).toBeNull();
  });

  it('🔴 USER content is excluded, and only where it was declared', () => {
    // A person may be called `myCoolName` and upload `myCoolPic.png`. Neither is a prose defect, and
    // a gate that failed on them would be red on real data for reasons nobody could fix.
    const withUserText =
      'Account 91 (myCoolName) registered 2026-09-03T00:20:00.000Z. Signals — ' +
      'content-templating: 6 new accounts uploaded a file with the same name — “myCoolPic.png”. ' +
      NO_ACTION_TAKEN;
    expect(prosePolice(withUserText, ['myCoolName', 'myCoolPic.png'])).toBeNull();

    // 🔴 AND THE EXCLUSION IS NOT A BLANKET ESCAPE. Declaring user text must not hide a leak
    // elsewhere in the same string, or every call site could be made green by passing a literal.
    expect(
      prosePolice(`${withUserText} coCryShare 0.92`, ['myCoolName', 'myCoolPic.png'])?.match
    ).toBe('coCryShare');
    // Undeclared, so still checked: the same string without the declarations is caught.
    expect(prosePolice(withUserText)?.rule).toBe('camelCase');
  });

  it('🔴 the blanking REFUSES a literal that would eat prose instead of data', () => {
    // 🔴 A GUARD NOBODY HAS WATCHED FIRE IS A CLAIM ABOUT A CONDITION. `stripUserText` is a global
    // substring replace, so a short or common declared literal would delete ordinary words out of
    // the very sentences this file polices — and the gate would then go green for the wrong reason,
    // which is the one failure mode a gate must not have. Both arms are exercised here, and both
    // are asserted on the SPECIFIC error, so a throw from somewhere else cannot be read as a pass.
    const clean =
      'Signals — content-templating: 6 new accounts uploaded a file with the same name.';

    // (a) TOO SHORT. `new` would blank a word that appears in every one of these notes.
    expect(() => prosePolice(clean, ['new'])).toThrow(/too short to blank safely/);
    // Four characters is the floor, so the shortest legal literal is admitted rather than refused —
    // a guard that rejected everything would also be green, and for an equally wrong reason.
    expect(prosePolice(clean, ['logo'])).toBeNull();

    // (b) TOO COMMON. A four-character literal is long enough to pass (a) and can still be a
    // substring of the prose, which is the case the length floor alone cannot see.
    const repeated = 'name name name name name and a real finding.';
    expect(() => prosePolice(repeated, ['name'])).toThrow(/appears 5 times/);
    // …and a literal appearing a plausible number of times is still accepted, so the bound is a
    // ceiling on absurdity rather than a ban on repetition.
    expect(prosePolice('name and name again.', ['name'])).toBeNull();
  });

  it('🔴 POSITIVE CONTROL — it is looking at real, non-empty producer output', () => {
    // A gate wired to nothing returns a clean verdict on every input. So: the fixtures must actually
    // have produced sentences, from both producers, carrying the clauses the gate is meant to walk
    // past — above all the notes, which are the one part of the scoring still in the prose.
    const reasons = inScopeReasons();
    expect(reasons).toHaveLength(7);
    for (const { label, text } of reasons) {
      expect(text.length, `${label} produced no text`).toBeGreaterThan(80);
    }
    const botSignals = reasons[0].text;
    expect(botSignals).toContain('Signals — registration-cluster:');
    expect(botSignals).toContain('content-templating:');
    expect(reasons[4].text).toContain('rating');
  });
});

/**
 * 🔴 THE REAL DETECTOR, OVER THE REAL HEURISTIC REGISTRY — because the fixtures above are a
 * HAND-COPY of `explain()` output and a hand-copy cannot go stale loudly.
 *
 * The notes are the one part of the scoring still in the moderator's sentence, so they are the most
 * likely place a future identifier leaks: a heuristic author writes `explain` in the same file as
 * the scorer, fluent in its own vocabulary. A gate whose note text is typed into the test file goes
 * on passing for whatever the heuristics actually emit. Two concrete gaps that check closed: the
 * hand-built fixture pins `asset-staging` at `note: null`, so `heuristics/staging.ts`'s clause was
 * never seen at all; and `clustering.ts` interpolates an account's EMAIL DOMAIN into its note, which
 * no fixture above declares.
 *
 * So these two cases build a cohort, run `runBotAccountDetection` with no `heuristics` override —
 * i.e. `BOT_ACCOUNT_HEURISTICS`, the shipped registry — and push every EMITTED finding through the
 * same checker. `minConfidence: 0` so nothing is filtered out and the low-scoring reasons are
 * checked too.
 */
describe('the gate over REAL detector output, not a hand-copy of it', () => {
  const account = (id: number): NewAccountRow => ({
    id,
    username: `newcomer${id}`,
    createdAt: new Date('2026-09-03T01:00:00.000Z'),
    email: `newcomer${id}@ring-domain.test`,
  });

  const readerOver = (accounts: NewAccountRow[], imagesEach: number): CohortReader => ({
    listNewAccounts: async ({ before, take }) =>
      [...accounts]
        .sort((a, b) => b.id - a.id)
        .filter((a) => before === undefined || a.id < before)
        .slice(0, take),
    countPosts: async (ids) => ({
      comments: [],
      commentsV2: [],
      models: [],
      images: ids.map((userId) => ({ userId, count: imagesEach })),
      allComments: [],
      allCommentsV2: [],
      allModels: [],
      allImages: ids.map((userId) => ({ userId, count: imagesEach })),
    }),
  });

  const runOver = async (
    accounts: NewAccountRow[],
    imagesEach: number,
    evidence: Parameters<typeof runBotAccountDetection>[0]['evidence']
  ) => {
    const reports: AbuseReportInput[] = [];
    await runBotAccountDetection(
      {
        reader: readerOver(accounts, imagesEach),
        evidence,
        sendReport: async (r) => {
          reports.push(r);
        },
        now: () => SCAN,
      },
      { pageSize: 10, maxAccounts: 10, minConfidence: 0 }
    );
    return reports;
  };

  it('🔴 a RING cohort — clustering, templating and velocity notes, as the heuristics write them', async () => {
    const accounts = Array.from({ length: 6 }, (_, i) => account(i + 1));
    const reports = await runOver(accounts, 40, {
      hasRegistrationIps: true,
      listRegistrationIps: async (ids: number[]) =>
        ids.map((userId) => ({ userId, ip: '203.0.113.9' })),
      listStagedImageSamples: async () => [],
      listFilenameSamples: async (ids: number[]) => ids.map((userId) => ({ userId, name: 'logo' })),
    });

    const findings = reports.flatMap((r) => r.findings);
    // Positive control: three distinct heuristics must actually have written a clause, or this case
    // is checking a reason with no notes in it — which is the state that hid the gap it exists for.
    expect(findings.length).toBeGreaterThan(0);
    const joined = findings.map((f) => f.reason).join('\n');
    for (const id of ['registration-cluster', 'content-templating', 'posting-velocity'])
      expect(joined, `${id} wrote no note — this case is not exercising it`).toContain(`${id}:`);

    // The username, the shared filename and the shared email domain are the three user-supplied
    // values these notes interpolate. Everything else is words this repo wrote.
    for (const finding of findings)
      expectCleanProse(finding.reason, [`newcomer${finding.userId}`, 'logo', 'ring-domain.test']);
  });

  it('🔴 a STAGED-UPLOAD cohort — the asset-staging note no fixture above reaches', async () => {
    // 🔴 THE CLAUSE THIS CHANGE ACTUALLY EDITED. The hand-built fixture pins `asset-staging` at
    // `score: 0, note: null`, so `heuristics/staging.ts`'s sentence — including the burst clause —
    // was invisible to every other case in this file.
    const accounts = Array.from({ length: 3 }, (_, i) => account(i + 1));
    const reports = await runOver(accounts, 6, {
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listFilenameSamples: async () => [],
      listStagedImageSamples: async (ids: number[]) =>
        ids.flatMap((userId) =>
          // Four staged uploads inside one second, so BOTH halves of the heuristic fire and both
          // clauses of its note are rendered.
          Array.from({ length: 4 }, (_, i) => ({
            userId,
            createdAt: new Date(new Date('2026-09-03T02:00:00.000Z').getTime() + i * 10),
          }))
        ),
    });

    const findings = reports.flatMap((r) => r.findings);
    expect(findings.length).toBeGreaterThan(0);
    const joined = findings.map((f) => f.reason).join('\n');
    expect(joined).toContain('asset-staging:');
    expect(joined).toContain('carry no generation metadata');
    expect(joined, 'the burst clause did not render — half the note is unchecked').toContain(
      'created within the same second'
    );

    for (const finding of findings)
      expectCleanProse(finding.reason, [`newcomer${finding.userId}`, 'ring-domain.test']);
  });
});

describe('plural — the helper both producers agree their grammar through', () => {
  it.each([
    [0, 'ratings'],
    [1, 'rating'],
    [2, 'ratings'],
    // A decimal is plural — `1.5 ratings`, and `0.5 ratings` too.
    [1.5, 'ratings'],
    [0.5, 'ratings'],
    // Negative one is the only value `Math.abs` changes the answer for, and it is the value a naive
    // `count === 1` test gets wrong in the direction that reads as a bug rather than a typo.
    [-1, 'rating'],
    [-2, 'ratings'],
  ])('%s → %s', (count, expected) => {
    expect(plural(count, 'rating')).toBe(expected);
  });

  it('takes an irregular plural, and a verb', () => {
    // The default appends `s`, which is wrong for both of these — the third argument is what stops
    // a caller open-coding the ternary and drifting from the rest of the board's wording.
    expect(plural(1, 'was', 'were')).toBe('was');
    expect(plural(2, 'was', 'were')).toBe('were');
    expect(plural(1, 'entry', 'entries')).toBe('entry');
    expect(plural(3, 'entry', 'entries')).toBe('entries');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────────

describe('moderator-facing reason prose — the two in-repo detectors', () => {
  it.each(inScopeReasons())(
    '$label reads as English, not as a debug line',
    ({ text, userText }) => {
      expectCleanProse(text, userText);
    }
  );

  it('🔴 the per-heuristic dump is gone from every one of them', () => {
    // Named separately from the regex rules because this is the concrete thing that shipped, and a
    // reader who breaks it should see it by name rather than as "assignment rule fired".
    for (const { label, text } of inScopeReasons()) {
      expect(text, `${label} still carries the per-heuristic clause`).not.toContain(
        'Per-heuristic'
      );
      expect(text, `${label} still restates the confidence column`).not.toContain(
        'Blended confidence'
      );
    }
  });

  it('🔴 both producers end a non-actioned finding with the SAME sentence, LAST', () => {
    // The standard is the wording AND the position. `bot-account-detection` used to open with
    // `Shadow-mode observation — NOT actioned.`, which named an internal rollout phase in the spot a
    // reader skips; `new-order-abuse-detection` already ended with the sentence below.
    const bot = buildFinding(member(), score(), SCAN).reason;
    const newOrder = renderReason(suspect(), false);
    for (const text of [bot, newOrder]) {
      expect(text.endsWith(NO_ACTION_TAKEN)).toBe(true);
      // Once, not twice — a sentence that also appears mid-string is a leftover, not a standard.
      expect(text.split(NO_ACTION_TAKEN)).toHaveLength(2);
    }
    // And the phrase it replaced is gone rather than merely moved.
    expect(bot).not.toContain('Shadow-mode observation');
    expect(bot).not.toContain('NOT actioned');
    // The actioned branch says what it DID instead — the disclaimer must not appear beside a live
    // penalty, which is the one direction this standard must never be applied in.
    expect(renderReason(suspect(), true)).not.toContain(NO_ACTION_TAKEN);
  });

  it('🔴 no `(s)` suffixes survive in either producer’s findings', () => {
    // The mechanical half of readability. `591 rating(s)` is a template showing through; a moderator
    // reads `591 ratings`.
    for (const { label, text } of inScopeReasons())
      expect(text, `${label} still carries an "(s)" suffix`).not.toMatch(/\(s\)/);
  });

  it('🔴 singular and plural both resolve, in both producers', () => {
    // Watched at BOTH ends rather than only the plural one: a helper hardcoded to always append `s`
    // passes every plural case in this file and fails only here.
    const one = renderPostCounts(posts({ comments: 1, models: 1, images: 1 }));
    expect(one).toContain('Posted 3 items — 1 comment, 1 model, 1 image.');
    const many = renderPostCounts(posts({ comments: 2, models: 0, images: 3 }));
    expect(many).toContain('Posted 5 items — 2 comments, 0 models, 3 images.');
    // Zero is plural, which is the case a naive `n > 1` test gets wrong.
    expect(many).toContain('0 models');

    expect(
      renderReason(suspect({ totalRatings: 1, uniqueRatings: 1, avgPerMinute: 1 }), false)
    ).toContain('cast 1 rating in the last 24h using 1 distinct rating value.');
    expect(renderReason(suspect(), false)).toContain(
      'cast 591 ratings in the last 24h using 5 distinct rating values.'
    );
    // The verb agrees as well as the noun — `1 were auto-smited` was the shipped spelling.
    expect(renderSummary([suspect()], 1)).toContain('1 was auto-smited by the scan');
    expect(renderSummary([suspect(), suspect({ userId: 101 })], 2)).toContain(
      '2 were auto-smited by the scan'
    );
  });

  it('🔴 the per-row definition of the on-site categories moved to the run summary', () => {
    // It was ~260 characters of identical prose on every finding of a run that can carry a thousand
    // of them. The legend still exists — this asserts WHERE, so "shortened" cannot quietly mean
    // "deleted": the reason keeps the account's own numbers, the legend keeps the definitions.
    const withExclusions = renderPostCounts(posts({ comments: 5, images: 40 }, { comments: 2 }));
    expect(withExclusions).toContain('Still on the site: 2');
    expect(withExclusions).toContain('No longer on the site: 43');
    // The ENUMERATION moved; the CAVEAT did not, and the split is load-bearing rather than tidy.
    // `apps/moderator/src/routes/retool/user-lookup/AbuseFindingsPanel.svelte` renders a reason with
    // no run summary anywhere on the screen, so anything moved to the summary is unreachable from
    // that surface — fine for a list of which states fall where, not fine for a caveat that inverts
    // what "still on the site" means.
    expect(withExclusions).not.toContain('TOS-flagged');
    expect(withExclusions).toContain('Images awaiting a scan result count as on the site.');

    expect(POST_COUNT_LEGEND).toContain('TOS-flagged');
    expect(POST_COUNT_LEGEND).not.toContain('awaiting a scan result');
    // The legend is prose a moderator reads too, so it is held to the same bar.
    expectCleanProse(POST_COUNT_LEGEND);
  });

  it('🔴 the reason a moderator reads got materially shorter', () => {
    // Measured on this exact fixture: 690 characters at `origin/main`, 516 here.
    //
    // ⚠️ THIS BOUND IS NOT WHAT CATCHES THE DUMP COMING BACK, and saying so is the point — a length
    // assertion reads as if it were. Measured: re-adding the per-heuristic clause puts this fixture
    // at 626 — over this 700 only because 700 is loose, and it was under the previous 600 bound at
    // the time, i.e. this line has ALREADY been observed staying green on that mutant. What kills it
    // is the `assignment` rule in the it.each above, which was watched doing so. This bound is a
    // coarse backstop against a gross regression, deliberately loose so ordinary edits to the
    // sentence do not break it, and it must not be cited as the dump guard.
    const reason = buildFinding(member(), score(), SCAN).reason;
    expect(reason.length).toBeLessThan(700);
    // And not shortened by dropping the evidence: the account's own facts are all still there.
    expect(reason).toContain('Account 91 (newcomer)');
    expect(reason).toContain('3.0h old at scan');
    expect(reason).toContain('Posted 6 items — 2 comments, 1 model, 3 images.');
    expect(reason).toContain('Signals —');
  });
});

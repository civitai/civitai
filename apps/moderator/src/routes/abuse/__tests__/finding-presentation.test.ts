import { describe, expect, it } from 'vitest';
import { ABUSE_VERDICTS } from '$lib/abuse-verdicts';
import { groupFindings } from '$lib/abuse-decisions';
import {
  NAMED_MEMBERS,
  VERDICT_CLASS,
  VERDICT_HINT,
  VERDICT_LABEL,
  VERDICT_QUESTION,
  confidenceLabel,
  findingBullets,
  moreMembersLabel,
  verdictAttribution,
  type RenderableFinding,
} from '../[runId]/finding-presentation';
import { stripComments } from '../../../test/strip-comments';
import {
  LIST_PAGE_DIR,
  RUN_PAGE_DIR,
  pageSurface,
  read,
  readRaw,
  sourcesUnder,
} from './page-sources';

/**
 * The board's sentences.
 *
 * 🔴 EVERY CASE HERE IS A SEPARATOR OR AN AGREEMENT, because those are what a template gets wrong
 * silently. Svelte trims the whitespace at the edges of a block, so a space typed at the start of an
 * `{#if}` is deleted at compile time: the source reads `and 6 more` and the page renders
 * `…1234and 6 more`. Nothing errors, typecheck is clean, and no review that reads the diff sees it,
 * because the diff contains the space.
 *
 * Two of those shipped — the cluster's "and N more" tail and the separator between a ruler and their
 * timestamp — so the last block below pins the CLASS rather than the two instances: any block tag on
 * this board whose content opens with mid-sentence text.
 */

describe('verdictAttribution', () => {
  const at = new Date('2026-09-03T03:20:00Z');
  const stamp = () => 'Sep 3, 2026';

  it('renders nothing when nobody has ruled', () => {
    expect(verdictAttribution(null, at, 77, stamp)).toBeNull();
  });

  it('names the reader as "you"', () => {
    expect(verdictAttribution('77', null, 77, stamp)).toBe('you');
  });

  it('keeps the stored id for anybody else', () => {
    // The column holds an id rather than a username precisely because a rename cannot move an id.
    // Resolving it to a name here would put a handle that has since changed hands beside a ruling.
    expect(verdictAttribution('42', null, 77, stamp)).toBe('moderator #42');
  });

  it('keeps the stored id when there is no reader to compare against', () => {
    expect(verdictAttribution('42', null, null, stamp)).toBe('moderator #42');
  });

  it('🔴 compares as a STRING — a padded id is not the reader', () => {
    // `Number('007') === 7` is true, so a numeric comparison would greet somebody else as themselves.
    expect(verdictAttribution('007', null, 7, stamp)).toBe('moderator #007');
  });

  it('🔴 does not weld the ruler to the timestamp', () => {
    // The shipped defect, verbatim: the separator was typed at the start of an `{#if}` block, so
    // Svelte trimmed the space before it and the board rendered `moderator #42· Sep 3, 2026`.
    expect(verdictAttribution('42', at, 77, stamp)).toBe('moderator #42 · Sep 3, 2026');
  });

  it('renders no separator when there is nothing to separate', () => {
    expect(verdictAttribution('42', null, 77, stamp)).toBe('moderator #42');
  });

  it('formats the timestamp with the formatter it is given, not its own', () => {
    // `dateTime` prints the viewer's zone AND UTC, and that belongs to one module. A second
    // spelling here is how two screens start disagreeing about when something happened.
    expect(verdictAttribution('42', at, null, (d) => `@${d.toISOString()}`)).toBe(
      'moderator #42 · @2026-09-03T03:20:00.000Z'
    );
  });
});

describe('moreMembersLabel', () => {
  it('🔴 opens with a space — the shipped defect was its absence', () => {
    expect(moreMembersLabel(10, 4)).toBe(' and 6 more');
  });

  it('says nothing when every member is already named', () => {
    expect(moreMembersLabel(4, 4)).toBe('');
  });

  it('says nothing when there are fewer members than examples', () => {
    expect(moreMembersLabel(2, 4)).toBe('');
  });

  it('counts one remaining member', () => {
    expect(moreMembersLabel(5, 4)).toBe(' and 1 more');
  });
});

describe('confidenceLabel', () => {
  it('renders two digits, never a percentage', () => {
    // A percentage invites a cross-detector ranking that would be meaningless — the producers do not
    // share a calibration.
    expect(confidenceLabel(0.9137)).toBe('0.91');
    expect(confidenceLabel(1)).toBe('1.00');
  });

  it('🔴 labels 0.00 as a judged verdict rather than leaving it to read as "unscored"', () => {
    // It renders beside a reason that describes the evidence in detail, which reads as
    // self-contradictory unless the zero is explained — a moderator then either dismisses a real
    // finding or trusts a rejected one. The user-lookup panel has said this about the same rows
    // since it was built; this board showed the bare number, so the two screens gave one row two
    // readings.
    expect(confidenceLabel(0)).toContain('0.00');
    expect(confidenceLabel(0)).toMatch(/judged not abuse/i);
  });

  it('says it of zero and of nothing else', () => {
    expect(confidenceLabel(0.01)).toBe('0.01');
    // 🔴 ROUNDS TO 0.00 BUT IS NOT ZERO. A real score below the two-digit floor is not a judged
    // verdict, and labelling it as one would be the board asserting something no detector said.
    expect(confidenceLabel(0.0001)).toBe('0.00');
  });
});

/**
 * The key-info list that replaced the wall of prose at the top of a finding.
 *
 * 🔴 EVERY FIXTURE HERE GOES THROUGH THE REAL `groupFindings`, not a hand-built `Decision`. The
 * bullets read `decision.lead` for the lead's facts and `decision.members.slice(1, …)` for the other
 * members, which is correct ONLY because `groupFindings` puts the lead at `members[0]`. A hand-built
 * fixture can satisfy both halves while that relationship is broken, so the seam would go unasserted.
 */
const REASON = 'Example reason: several sentences of producer prose that the list must not quote.';

const finding = (over: Partial<RenderableFinding> & { id: number }): RenderableFinding => ({
  // Pairwise distinct from `id` on purpose: a bullet that renders the finding id where the account
  // belongs is invisible when a fixture makes the two equal.
  userId: over.id + 1000,
  actioned: false,
  confidence: 0.5,
  groupKey: null,
  verdict: null,
  reason: REASON,
  action: null,
  verdictBy: null,
  verdictAt: null,
  ...over,
});

/** One decision from `n` findings sharing a key, lead first — confidences descend so the lead is `1`. */
const cluster = (n: number, lead: Partial<RenderableFinding> = {}) => {
  const members = Array.from({ length: n }, (_, i) =>
    finding({ id: i + 1, groupKey: 'ring', confidence: 0.9 - i * 0.01, ...(i === 0 ? lead : {}) })
  );
  const decisions = groupFindings(members);
  expect(decisions, 'the fixture must collapse to one decision').toHaveLength(1);
  expect(decisions[0].lead.id, 'the lead must be the first member').toBe(1);
  return decisions[0];
};

const bulletsOf = (n: number, lead: Partial<RenderableFinding> = {}) =>
  findingBullets(cluster(n, lead));
const byKeyOf = (bullets: ReturnType<typeof findingBullets>, key: string) => {
  const b = bullets.find((x) => x.key === key);
  expect(b, `no \`${key}\` bullet`).toBeTruthy();
  return b!;
};
const byKey = (n: number, key: string, lead: Partial<RenderableFinding> = {}) =>
  byKeyOf(bulletsOf(n, lead), key);

describe('findingBullets — order', () => {
  it('an ungrouped finding gets account, detector action, confidence — in that order', () => {
    // 🔴 THE ORDER IS THE DESIGN. Identity is the subject of the decision; what the detector already
    // DID carries consequences a score does not, so it precedes the score. A list whose fields move
    // between cards is the thing this replaced.
    expect(bulletsOf(1).map((b) => b.key)).toEqual(['account', 'action', 'confidence']);
  });

  it('a cluster inserts "ruled together" SECOND, right after the account it qualifies', () => {
    // Ruling one account and ruling eleven are different acts, and the size qualifies the id above it.
    expect(bulletsOf(11).map((b) => b.key)).toEqual(['account', 'cluster', 'action', 'confidence']);
  });

  it('every key is unique — they are the `{#each}` key', () => {
    const keys = bulletsOf(11).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('findingBullets — the account', () => {
  it('links the LEAD account, with nothing before it', () => {
    const b = byKey(1, 'account');
    expect(b.label).toBe('Account');
    expect(b.text).toBe('');
    expect(b.links).toEqual([{ userId: 1001, prefix: '', key: '1' }]);
    expect(b.tail).toBe('');
    expect(b.badge).toBeNull();
  });

  it('🔴 does not name the lead a second time in the cluster bullet', () => {
    // `members[0]` IS the lead. A cluster bullet built from `slice(0, …)` instead of `slice(1, …)`
    // renders the same account twice and inflates the apparent cohort by one.
    expect(byKey(11, 'cluster').links.map((l) => l.userId)).not.toContain(1001);
  });
});

/**
 * 🔴 THE LINK KEY IS THE FINDING'S PRIMARY KEY, AND `userId` IS NOT A SUBSTITUTE FOR IT.
 *
 * This is a regression test for a shipped-shaped defect, not a hypothetical. `abuse_detection_finding`
 * has NO unique index on `(run_id, user_id)`; the ingest service documents that the wire contract
 * permits two findings for one account in one run, and `group_key` is derived from an account attribute
 * so those two land in the SAME cluster. Keyed on `userId`, the template then emits one key twice —
 * and Svelte 5 throws `each_key_duplicate` outside DEV as well as in it, so the whole run page dies on
 * hydration rather than mis-wiring a single row.
 *
 * 🔴 AND THE FIXTURE ABOVE CANNOT SEE IT: `userId: over.id + 1000` makes every account id distinct by
 * construction, which is exactly the "fixture constants pairwise distinct from each other but never
 * COLLIDING" blind spot. This block builds the colliding case on purpose.
 */
describe('findingBullets — two findings, one account, one run', () => {
  /**
   * 🔴 THE REPEAT MUST SIT BETWEEN TWO NON-LEAD MEMBERS, and getting that wrong is how this test was
   * vacuous on its first draft. Each bullet renders its own `{#each}`, so Svelte keys them
   * independently: a lead that repeats an account also named in the CLUSTER bullet is two separate
   * loops, not one duplicate key. The hazard exists only WITHIN the cluster loop, so the collision has
   * to be between `members[1]` and `members[2]`. Found by mutation — keyed on `userId`, the first
   * fixture still produced three distinct keys and the test passed.
   *
   * Distinct PKs carrying a repeated account id is precisely what the table permits.
   */
  const sameAccount = () => {
    const members = [
      finding({ id: 7, userId: 4242, groupKey: 'ring', confidence: 0.9 }),
      finding({ id: 8, userId: 5555, groupKey: 'ring', confidence: 0.8 }),
      finding({ id: 9, userId: 5555, groupKey: 'ring', confidence: 0.7 }),
    ];
    const decisions = groupFindings(members);
    expect(decisions, 'all three share a key, so they are one decision').toHaveLength(1);
    expect(decisions[0].lead.id, 'finding 7 must lead').toBe(7);
    return findingBullets(decisions[0]);
  };

  it('🔴 emits distinct link keys even when the account ids repeat', () => {
    // Scoped to the ONE loop where a duplicate is representable — see the note above.
    const links = byKeyOf(sameAccount(), 'cluster').links;
    const keys = links.map((l) => l.key);
    // The control that makes the assertion mean something: within THIS loop the account ids really do
    // repeat, so a `userId`-keyed loop would be emitting a duplicate key right here.
    expect(
      new Set(links.map((l) => l.userId)).size,
      'the fixture must repeat an account inside one loop'
    ).toBeLessThan(links.length);
    expect(new Set(keys).size, `duplicate key among ${keys.join(',')}`).toBe(keys.length);
  });

  it('🔴 keys on the finding PK, not the account id', () => {
    // Pinned as exact values so a future "simplify" back to `String(userId)` fails here rather than in
    // a browser. The lead is finding 7; the cluster names 8 and 9, which share an account.
    expect(byKeyOf(sameAccount(), 'account').links).toEqual([
      { userId: 4242, prefix: '', key: '7' },
    ]);
    expect(byKeyOf(sameAccount(), 'cluster').links).toEqual([
      { userId: 5555, prefix: ' — ', key: '8' },
      { userId: 5555, prefix: ', ', key: '9' },
    ]);
  });
});

describe('findingBullets — the cluster', () => {
  it('counts the WHOLE cluster, names the others, and owns every separator', () => {
    // 11 members: 10 others, 4 named, 6 counted. Not a multiple of NAMED_MEMBERS, so an off-by-one in
    // the cap cannot land exactly on the boundary and hide.
    const b = byKey(11, 'cluster');
    expect(b.label).toBe('Ruled together');
    expect(b.text).toBe('11 accounts');
    expect(b.links).toEqual([
      { userId: 1002, prefix: ' — ', key: '2' },
      { userId: 1003, prefix: ', ', key: '3' },
      { userId: 1004, prefix: ', ', key: '4' },
      { userId: 1005, prefix: ', ', key: '5' },
    ]);
    expect(b.tail).toBe(' and 6 more');
    expect(b.badge).toBeNull();
  });

  it('🔴 the first separator is NOT the one between names', () => {
    // The whole point of carrying the separator on the link: ` — ` joins the count to the list, `, `
    // joins one name to the next. One `prefix` for both renders `11 accounts, 1002, 1003`.
    const [first, ...rest] = byKey(11, 'cluster').links;
    expect(first.prefix).not.toBe(rest[0].prefix);
  });

  it('🔴 every separator carries its own spaces — none is typed in the template', () => {
    const b = byKey(11, 'cluster');
    for (const l of b.links) expect(l.prefix, `${l.userId} would weld`).toMatch(/^\s|\s$/);
    expect(b.tail).toMatch(/^ /);
  });

  it('agrees the tail with ONE remaining member', () => {
    // 6 members: 5 others, 4 named, 1 counted.
    expect(byKey(6, 'cluster').tail).toBe(' and 1 more');
  });

  it('says nothing about more when every other member is named', () => {
    // 3 members: 2 others, both named.
    const b = byKey(3, 'cluster');
    expect(b.links).toHaveLength(2);
    expect(b.tail).toBe('');
  });

  it(`names at most ${NAMED_MEMBERS}, however large the cluster`, () => {
    const b = byKey(40, 'cluster');
    expect(b.links).toHaveLength(NAMED_MEMBERS);
    expect(b.tail).toBe(' and 35 more');
  });
});

describe('findingBullets — what the detector did', () => {
  it('spells out the common case rather than leaving it blank', () => {
    // "Detected, scored, deliberately left alone" is the commonest row on this board; a blank reads as
    // missing data on a surface whose whole claim is honest reporting.
    const b = byKey(1, 'action');
    expect(b.label).toBe('Detector action (reported)');
    expect(b.badge).toEqual({ variant: 'secondary', text: 'Not acted on' });
    expect(b.text).toBe('');
  });

  it('names the action when there was one', () => {
    const b = byKey(1, 'action', { actioned: true, action: 'exclude' });
    expect(b.badge).toEqual({ variant: 'destructive', text: 'Acted' });
    expect(b.text).toBe('exclude');
  });

  it('🔴 keeps producer free text OUT of the badge, which cannot wrap', () => {
    // `badgeVariants.base` carries `whitespace-nowrap shrink-0 overflow-hidden`, and an action name is
    // up to 64 characters of producer-supplied string. In the badge it pushes out of the card; in
    // `text` it wraps. So the badge holds the category and nothing variable.
    const long = 'x'.repeat(64);
    const b = byKey(1, 'action', { actioned: true, action: long });
    expect(b.badge?.text, 'the badge must stay categorical').toBe('Acted');
    expect(b.badge?.text).not.toContain(long);
    expect(b.text).toBe(long);
  });

  it('🔴 renders no dangling separator when `actioned` carries no `action`', () => {
    // A CHECK forbids the pair, but the column the board reads is `text | null`. `Acted: ` with
    // nothing after it reads as a value that failed to load — and `action ?? 'unknown'` would print a
    // value no producer reported.
    const b = byKey(1, 'action', { actioned: true, action: null });
    expect(b.badge).toEqual({ variant: 'destructive', text: 'Acted' });
    expect(b.text).toBe('');
    expect(b.text).not.toMatch(/[:—-]\s*$/);
  });

  /**
   * 🔴 ON A CLUSTER THE COUNT IS ACROSS THE MEMBERS, NEVER READ OFF THE LEAD.
   *
   * `groupFindings` sorts `actioned desc`, so ONE acted-on member promotes itself to lead — and the
   * lead's flag presented as the decision's reads "all 11 of these were excluded" when one was. A
   * moderator who believes the cohort is already handled declines to act, which is the expensive
   * direction. The new layout puts this line directly under the cluster size, which is the adjacency
   * that invites the misreading.
   */
  const mixedCluster = (actedCount: number, size: number) => {
    const members = Array.from({ length: size }, (_, i) =>
      finding({
        id: i + 1,
        groupKey: 'ring',
        confidence: 0.9 - i * 0.01,
        ...(i < actedCount ? { actioned: true, action: 'exclude' } : {}),
      })
    );
    const decisions = groupFindings(members);
    expect(decisions).toHaveLength(1);
    return byKeyOf(findingBullets(decisions[0]), 'action');
  };

  it('🔴 reports 1 of 11, not "Acted", when one member of eleven was acted on', () => {
    const b = mixedCluster(1, 11);
    expect(b.badge).toEqual({ variant: 'destructive', text: 'Acted on 1 of 11' });
    expect(b.badge?.text, 'the lead flag must not stand in for the cohort').not.toBe('Acted');
  });

  it('counts several acted-on members', () => {
    expect(mixedCluster(7, 11).badge).toEqual({
      variant: 'destructive',
      text: 'Acted on 7 of 11',
    });
  });

  it('says none of eleven rather than a bare "Not acted on"', () => {
    expect(mixedCluster(0, 11).badge).toEqual({
      variant: 'secondary',
      text: 'None of 11 acted on',
    });
  });

  it('lists each DISTINCT action name once, separator owned here', () => {
    const members = [
      finding({ id: 1, groupKey: 'r', confidence: 0.9, actioned: true, action: 'exclude' }),
      finding({ id: 2, groupKey: 'r', confidence: 0.8, actioned: true, action: 'unexclude' }),
      finding({ id: 3, groupKey: 'r', confidence: 0.7, actioned: true, action: 'exclude' }),
    ];
    const b = byKeyOf(findingBullets(groupFindings(members)[0]), 'action');
    expect(b.text).toBe('exclude, unexclude');
    expect(b.badge).toEqual({ variant: 'destructive', text: 'Acted on 3 of 3' });
  });
});

describe('findingBullets — the producer figures', () => {
  it('🔴 carries the two-digit confidence, and the 0.00 reading, from the one place that spells it', () => {
    expect(byKey(1, 'confidence', { confidence: 0.9137 }).text).toBe('0.91');
    expect(byKey(1, 'confidence', { confidence: 0 }).text).toBe(confidenceLabel(0));
    expect(byKey(1, 'confidence', { confidence: 0 }).text).toMatch(/judged not abuse/i);
  });

  it('🔴 hedges BOTH self-reported figures as "(reported)" — and only those two', () => {
    // Neither is ever cross-checked against the action log. Without the word the list reads as the
    // board CONFIRMING something was done. Asserted as the exact set, because adding the hedge to a
    // bullet that is not a producer self-report would make it meaningless on the two that are.
    expect(
      bulletsOf(11)
        .filter((b) => b.label.includes('(reported)'))
        .map((b) => b.label)
    ).toEqual(['Detector action (reported)', 'Confidence (reported)']);
  });
});

describe('findingBullets — built from fields, never from prose', () => {
  it('🔴 quotes no part of the reason', () => {
    // Five detectors post here and two of them — most of the runs — have no code in this repo, so
    // their wording is not ours to parse. A bullet derived from the text would break invisibly on a
    // producer's reword.
    const all = bulletsOf(11, { actioned: true, action: 'exclude' });
    for (const b of all) {
      // 🔴 EVERY RENDERED FIELD, badge text included — a ledger that omits one leaves the next bullet
      // free to quote the prose through the field nobody enumerated.
      for (const part of [b.label, b.text, b.tail, b.badge?.text ?? '']) {
        expect(part, `${b.key} quotes the reason`).not.toContain('Example reason');
        expect(part).not.toContain(REASON);
      }
    }
  });

  it('every bullet has a label and something to show', () => {
    // A ledger over the list: a bullet added with an empty value renders a dangling label. The value
    // can arrive as plain text, as links, as a tail, or as the badge — so all four count.
    for (const b of bulletsOf(11, { actioned: true, action: 'exclude' })) {
      expect(b.label.length, b.key).toBeGreaterThan(0);
      expect(
        b.text.length + b.links.length + b.tail.length + (b.badge?.text.length ?? 0),
        b.key
      ).toBeGreaterThan(0);
    }
  });

  it('🔴 a bullet with a badge still renders its text — the fields are not alternatives', () => {
    // The action bullet is the one that carries both, and that is why the template must not branch
    // badge-OR-text. If this ever holds a badge with nothing beside it for an acted finding, the
    // action name has been folded back into the badge, where it cannot wrap.
    const b = byKey(1, 'action', { actioned: true, action: 'exclude' });
    expect(b.badge).toBeTruthy();
    expect(b.text.length).toBeGreaterThan(0);
  });
});

describe('every verdict the board offers is spelled out', () => {
  // 🔴 A LEDGER OVER THE SHARED TUPLE, not three hand-written cases. A fourth verdict added to
  // `ABUSE_VERDICTS` renders a fourth button; without this it would render an EMPTY one, with no
  // hint under it, no colour, and nothing failing.
  it.each(ABUSE_VERDICTS)('%s has a label, a visible hint and both button states', (v) => {
    expect(VERDICT_LABEL[v]?.length ?? 0).toBeGreaterThan(0);
    expect(VERDICT_HINT[v]?.length ?? 0).toBeGreaterThan(0);
    expect(VERDICT_CLASS[v]?.idle?.length ?? 0).toBeGreaterThan(0);
    expect(VERDICT_CLASS[v]?.chosen?.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE WHOLE STRING, NOT A WORD IN IT, and the reason is this change's own substance. A guard that
   * looked for "abuse" somewhere passes on "The detector was right about this abuse" — the exact
   * detector-relative framing being removed — so it would certify the defect. These three objects are
   * the operator's requested wording; a reword is a product decision and must come here first.
   *
   * WHAT THE OLD WORDING DID. `Correct` / `False positive` named the DETECTOR's correctness, and under
   * that reading the stored verdict's meaning INVERTED between two populations: on a flagged-but-
   * unactioned finding `tp` meant "this is abuse", while on a `confidence = 0` finding — whose reason
   * opens "Judged and deliberately NOT actioned", i.e. the detector decided the account was FINE —
   * `tp` meant "this is NOT abuse". Nothing on screen said which one a moderator was looking at.
   */
  it('🔴 the labels ask about the ACCOUNT — pinned whole, not by keyword', () => {
    expect(VERDICT_LABEL).toEqual({
      tp: 'This is abuse',
      fp: 'This is not abuse',
      skip: 'Skip',
    });
  });

  it('🔴 the hints ask about the ACCOUNT, and both judgements name the independence', () => {
    // The "regardless" clause is on BOTH `tp` and `fp` deliberately: on only one, it implies the other
    // IS relative to what the detector did, which is the reading being removed.
    expect(VERDICT_HINT).toEqual({
      tp: 'This account is abusing the site — regardless of what the detector did.',
      fp: 'This account is not abusing the site — regardless of what the detector did.',
      skip: 'Looked at it; not calling it either way.',
    });
  });

  it('🔴 the question above the buttons names the account', () => {
    expect(VERDICT_QUESTION).toBe('Your verdict — is this account abusing the site?');
  });

  it('🔴 no label or hint grades the DETECTOR — the class, not the two strings it replaced', () => {
    // Pinning the strings above catches a change; this catches the SHAPE coming back under new words,
    // which is what a future "make it clearer" edit would reach for.
    for (const v of ABUSE_VERDICTS) {
      for (const s of [VERDICT_LABEL[v], VERDICT_HINT[v]]) {
        expect(s, `${v}: a verdict is not a grade on the detector`).not.toMatch(
          /\bdetector (?:was|is) (?:right|wrong|correct)\b|\bfalse positive\b/i
        );
      }
    }
    expect(VERDICT_QUESTION).not.toMatch(/\bdetector\b/i);
  });

  it('the question and the buttons are rendered, not left as dead constants', () => {
    const src = pageSurface(RUN_PAGE_DIR);
    expect(src).toMatch(/\{VERDICT_QUESTION\}/);
    expect(src).toMatch(/\{VERDICT_LABEL\[v\]\}/);
  });

  it('offers no label, hint or palette for a verdict the tuple does not contain', () => {
    const tuple = [...ABUSE_VERDICTS].sort();
    expect(Object.keys(VERDICT_LABEL).sort()).toEqual(tuple);
    expect(Object.keys(VERDICT_HINT).sort()).toEqual(tuple);
    expect(Object.keys(VERDICT_CLASS).sort()).toEqual(tuple);
  });

  it.each(ABUSE_VERDICTS)('%s reacts to a hover in BOTH states', (v) => {
    // 🔴 A CHOSEN BUTTON IS STILL CLICKABLE — re-ruling overwrites, deliberately. With its two
    // neighbours lighting up on hover and the filled one inert, it reads as disabled, and that
    // misreading arrived WITH the fill: nothing was distinguishable enough to notice before.
    expect(VERDICT_CLASS[v].idle).toMatch(/\bhover:/);
    expect(VERDICT_CLASS[v].chosen).toMatch(/\bhover:/);
  });

  it('the chosen state is filled, not tinted', () => {
    // The defect: `bg-muted/60` on a transparent button, a lightness step of about 0.03 against this
    // page's panel. A fractional-opacity background is that same non-treatment respelled.
    for (const v of ABUSE_VERDICTS) {
      expect(VERDICT_CLASS[v].chosen).toMatch(/\bbg-[a-z0-9-]+\b/);
      expect(VERDICT_CLASS[v].chosen).not.toMatch(/\bbg-[a-z0-9-]+\/\d/);
    }
  });

  it('the hints are rendered, not hidden behind a hover', () => {
    // 🔴 THE COMMENT ABOVE THEM CLAIMED "spelled out beside the buttons" WHILE THEY WERE A `title`.
    // A tooltip is invisible to a moderator who does not hover, invisible to a touch device, and
    // invisible in the screenshot this team reports by. The claim and the code now agree; this is
    // what stops them drifting apart again.
    const src = pageSurface(RUN_PAGE_DIR);
    expect(src).toMatch(/\{VERDICT_HINT\[v\]\}/);
    expect(src).not.toMatch(/title=\{VERDICT_HINT/);
  });
});

/**
 * 🔴 THE CLASS, NOT THE TWO INSTANCES. Svelte deletes the whitespace at the start of a block's
 * content, so a block whose text opens mid-sentence — a separator, a conjunction, a continuation —
 * welds to whatever preceded the block. Both shipped bugs on this board had exactly this shape, and
 * a guard naming "and" and "·" would be walked past by the third one spelling it differently.
 *
 * A block opening with an element, a comment or another expression is fine and is what almost every
 * block here does; that is why the rule can be this blunt.
 */
const BLOCK_OPENING_WITH_TEXT = /\{[#:][^{}]*\}[^\S\n]*\n?[^\S\n]*[^\s<{]/g;

/**
 * Markup only — comments removed.
 *
 * 🔴 A COMMENT THAT NAMES A BLOCK TAG IS NOT A BLOCK TAG, and this rule is blunt enough to be fooled
 * by one: a line explaining what an each-block key is for read as an each-block opening with welded
 * text. Caught by this very guard on its own diff, which is the one time a false positive is cheap.
 *
 * Conservative on purpose. HTML comments and block comments go whole; a `//` comment is stripped
 * only when it OPENS its line, so a `https://` inside a string cannot be mistaken for one.
 */
export const withoutComments = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

describe('no block on the board opens with text Svelte will weld', () => {
  it('ignores a block tag named inside a comment — false-positive control', () => {
    expect(withoutComments('  // the {#each} key\n<p>x</p>')).not.toMatch(/\{#each\}/);
    expect(withoutComments('<!-- {#if x} and more -->\n<p>x</p>')).not.toMatch(/\{#if/);
    // …and does not eat a URL that merely contains a double slash.
    expect(withoutComments('<a href="https://example.test">x</a>')).toContain(
      'https://example.test'
    );
  });

  it('sees the defect that shipped — negative control', () => {
    // Both, verbatim as they were written.
    const shipped = [
      '{#if d.members.length > EXAMPLES + 1}\n                  and {num(1)} more{/if}',
      '{#if ruledAt(d)} · {dateTime(ruledAt(d) as Date)}{/if}',
    ];
    for (const src of shipped)
      expect([...src.matchAll(BLOCK_OPENING_WITH_TEXT)], src).not.toHaveLength(0);
  });

  it('allows a block that opens with an element — positive control', () => {
    const fine = '{#if run.summary}\n  <p class="x">{run.summary}</p>\n{/if}';
    expect([...fine.matchAll(BLOCK_OPENING_WITH_TEXT)]).toHaveLength(0);
  });

  it.each([RUN_PAGE_DIR, LIST_PAGE_DIR])('%s opens no block with welded text', (dir) => {
    const markup = withoutComments(pageSurface(dir));
    // The strip must not have taken the markup with it — an empty surface passes vacuously.
    expect(markup, `${dir} has no markup left after removing comments`).toMatch(/\{[#:]/);
    const offenders = [...markup.matchAll(BLOCK_OPENING_WITH_TEXT)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});

/**
 * 🔴 XGUARD'S `tp`/`fp` ARE A DIFFERENT THING AND MUST NOT FOLLOW THIS RELABEL.
 *
 * `routes/xguard/**` and `routes/api/xguard/**` are the XGuard label lab, where `tp`/`fp` are
 * CONFUSION-MATRIX COUNTS — integer columns sitting beside `tn`, `fn`, `precision`, `recall`, `f1` —
 * not a moderator's verdict on an account. They share two letters with this board's verdict codes and
 * nothing else, so a sweep that "made the wording consistent" across both would put a sentence about
 * an account where a tally of classifier outcomes belongs.
 *
 * The read is controlled: `sourcesUnder` throws rather than returning an empty list, so the "appears
 * nowhere" half cannot pass over nothing.
 */
/**
 * 🔴 EVERY SOURCE PIN IN THIS DIRECTORY RESTS ON `read` STRIPPING COMMENTS, SO THAT HAS TO BE PROVEN.
 *
 * A text pin cannot tell code from a sentence ABOUT the code: written against raw source it passes on
 * its own witness in a comment, and keeps passing after the code it pins is deleted.
 * `apps/moderator/src/test/strip-comments.ts` records three such incidents, and
 * `user-findings-round-trip.test.ts` records two mutants in this very directory that SURVIVED for
 * exactly that reason. `page-sources.ts` routes every read through that choke point; without this
 * block, nothing would notice it being unwired, and the `toMatch`/`not.toContain` pins below would
 * quietly go back to reading prose.
 */
describe('the source reads are comment-stripped', () => {
  const FILES = ['FindingCard.svelte', '+page.svelte', 'ProseDisclosure.svelte'].map(
    (f) => `${RUN_PAGE_DIR}/${f}`
  );

  it('🔴 strips markup and block comments — with the raw file as the positive control', () => {
    for (const f of FILES) {
      // The control first: if the raw file carried no comments, the assertion after it would hold
      // whether or not the strip ran, and this whole block would report success over nothing.
      expect(readRaw(f), `${f} has no comments — this control proves nothing`).toMatch(/<!--|\/\*/);
      expect(read(f), `${f}: markup comments survived`).not.toContain('<!--');
      expect(read(f), `${f}: block comments survived`).not.toContain('/*');
    }
  });

  it('🔴 a pin cannot be satisfied by a comment that merely names the thing', () => {
    // The concrete near-miss: `VerdictControl.svelte`'s comment points the reader at
    // `VERDICT_QUESTION`, and the pin below looks for the braced interpolation. One character apart.
    // Stripping is what makes the pin a claim about the markup rather than about the prose beside it.
    const planted = '<!-- renders {VERDICT_QUESTION} here -->\n<span>nothing</span>';
    expect(stripComments(planted)).not.toMatch(/\{VERDICT_QUESTION\}/);
    expect(planted, 'the planted comment must contain it, or this proves nothing').toMatch(
      /\{VERDICT_QUESTION\}/
    );
  });
});

describe('🔴 the relabel stops at the abuse board', () => {
  const XGUARD = ['routes/xguard', 'routes/api/xguard'];

  it('reads a non-empty xguard surface — positive control', () => {
    // Without this the two assertions below are claims about zero files. `tp` must be PRESENT there,
    // which is also what proves the subtree being read is the one that uses those names.
    const sources = XGUARD.flatMap(sourcesUnder);
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.filter((s) => /\btp\b/.test(s.src)).length).toBeGreaterThan(0);
  });

  it.each(XGUARD)('%s carries none of this board’s verdict wording', (dir) => {
    for (const { name, src } of sourcesUnder(dir)) {
      for (const phrase of [
        VERDICT_LABEL.tp,
        VERDICT_LABEL.fp,
        VERDICT_HINT.tp,
        VERDICT_HINT.fp,
        VERDICT_QUESTION,
      ]) {
        expect(src, `${name} picked up \`${phrase}\``).not.toContain(phrase);
      }
    }
  });

  it.each(XGUARD)('%s does not import the abuse board’s presentation module', (dir) => {
    // The cheap structural half: if nothing there imports these constants, no edit to them can reach
    // it, whatever the words happen to be.
    for (const { name, src } of sourcesUnder(dir)) {
      expect(src, `${name} imports the abuse board's strings`).not.toMatch(/finding-presentation/);
    }
  });
});

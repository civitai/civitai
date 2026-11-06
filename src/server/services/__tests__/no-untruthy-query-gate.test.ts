import { readFileSync } from 'fs';
import { globSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `enabled: features.X` does not disable a query. `enabled: !!features.X` does.
 *
 * Two facts combine, and neither is visible at the call site:
 *
 *  1. `FeatureAccess` is SPARSE at runtime while its type says dense — deliberately. Only `true`
 *     flags are present; an absent key reads `undefined`, so `if (!features.X)` works without
 *     coercion. That is also why a TYPE rule cannot catch this: the declared type is `boolean`, and
 *     if the type were the problem the typechecker would already be red.
 *  2. React Query resolves `enabled` as `!== false`, not by truthiness. `undefined` is ENABLED.
 *
 * So a flag-off query FIRES. The component still hides, because `if (!features.X) return null` is
 * fine on `undefined` — only the request survives. A kill switch that stops no traffic is worse
 * than no kill switch, because the next incident's flag flip looks like it did something.
 *
 * A compound reads worse still: `features.stickers && showBalances` is `undefined` when the flag is
 * absent, not `false`.
 *
 * Text scan rather than a lint rule for the reason in (1), and because the repo already enforces
 * several conventions this way. ClickUp 868kw8959.
 *
 * WHAT IT STILL CANNOT SEE, so nobody reads a green run as "the class is closed":
 *   - a value that continues on the NEXT line (prettier wraps any gate over ~100 chars, so this is
 *     the likeliest future miss);
 *   - a flag read behind a helper — `const enabled = useCreatorAnnouncementsFeature()` — where the
 *     flag is not on the line. Closing that needs a type-aware pass, which is a bigger thing than
 *     the bug;
 *   - the same mistake under a DIFFERENT key: `visible: … && features.X`, where `DescriptionTable`
 *     tests `visible === false`, is live at ResourceSelectCard.tsx today and is out of scope here;
 *   - a DEFAULT PARAMETER sink — `useQueryFollowedAnnouncements(enabled = true)`. Passing an absent
 *     flag there selects the default, so the gate does not merely fail to disable, it reads as ON.
 *     Its one instance is closed by coercing at the source, but the shape takes no `enabled:` key.
 *
 * `!!` is the only spelling this accepts. `Boolean(features.x)` and `features.x === true` are
 * equally correct and will be reported — fail-loud, and one spelling keeps the pattern readable.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The value of an `enabled:` key, up to the first `,` `}` or end of line. */
const ENABLED_VALUE = /\benabled:\s*([^,}\n]*)/g;
/**
 * A gate-shaped declaration — `const enabled = …`, `const stickersEnabled = …`. The flag is read
 * here and the gate is passed on as `{ enabled }` or `enabled: someVar`, which the key scan cannot
 * see. Five of the nine sites this guard was extended for had exactly this shape, one of them a
 * line above a site the first revision fixed.
 */
const GATE_DECL = /\b(?:const|let|var)\s+\w*(?:[eE]nabled|[aA]ctive)\b[^=\n]*=\s*([^;\n]*)/g;
/**
 * An uncoerced flag read. The lookbehind is what makes a COMPOUND work: testing the whole value
 * instead would let `enabled: features.a && !!b` pass, because it contains a `!!` — just not on the
 * read that matters. `features?.` is included because 20+ sites already write `!!features?.X`, so
 * the uncoerced spelling is one keystroke away.
 *
 * The lookbehind spans an identifier chain because the coercion can sit ahead of one:
 * `!!ctx.features.modelMetricPrivacyReadtime` IS coerced, and a bare `(?<!!!)` reads only the two
 * characters before `features.` — which are `x.` — and calls it a violation. Two real sites.
 */
const UNCOERCED = /(?<!!![\w$.]{0,40})\b(?:features\??\.|useFeatureFlags\(\)\??\.)/;
/** `!!(a || b)` coerces every read inside the group, so the group is removed before scanning. */
const COERCED_GROUP = /!!\([^()]*\)/g;
/** A line of prose rather than code — a jsdoc continuation, or a comment mentioning the pattern. */
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
/**
 * An opt-out, so a site that must stay uncoerced is VISIBLE rather than dodged by narrowing the
 * pattern — which would un-guard every other site at once.
 *
 * 🔴 It is RATCHETED: `every exemption is accounted for` below asserts the exact list, so adding one
 * is a red diff rather than a silent green. An unratcheted opt-out re-opens the door this guard
 * exists to hold shut, one line at a time.
 */
const EXEMPT = /no-untruthy-query-gate-exempt:/;
/** The only site allowed to stay uncoerced, and why — see the marker there for the pending call. */
const EXEMPTED = ['src/components/Resource/Forms/TrainingSelectFile.tsx:438'];

function uncoerced(value: string) {
  return UNCOERCED.test(value.replace(COERCED_GROUP, ''));
}

/**
 * The comment block directly above a line — contiguous comment lines only, stopping at the first
 * line of code.
 *
 * 🔴 Deliberately not "the last N lines". A fixed window exempts a WINDOW rather than a site: one
 * marker silently covers every gate below it, code in between and all. It is also fragile in the
 * other direction — the one live exemption's reason runs five lines, so a six-line window sits one
 * sentence away from ceasing to apply.
 */
function precedingComments(lines: string[], index: number) {
  const block: string[] = [];
  for (let i = index - 1; i >= 0 && COMMENT_LINE.test(lines[i]); i--) block.push(lines[i]);
  return block;
}

function hasBareGate(line: string, precedingLines: string[] = []) {
  if (COMMENT_LINE.test(line)) return false;
  // The marker sits on its own comment line(s) directly above the gate, like an eslint-disable.
  if (precedingLines.some((l) => EXEMPT.test(l))) return false;
  for (const pattern of [ENABLED_VALUE, GATE_DECL]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      if (uncoerced(match[1])) return true;
    }
  }
  return false;
}

let cached: { offenders: string[]; exempted: string[]; byExt: Record<string, number> } | undefined;

function scan() {
  if (cached) return cached;
  const files = globSync('src/**/*.{ts,tsx}', { cwd: REPO_ROOT });
  const offenders: string[] = [];
  const exempted: string[] = [];
  const byExt: Record<string, number> = { '.ts': 0, '.tsx': 0 };
  for (const rel of files) {
    const file = rel.split(path.sep).join('/');
    if (file.endsWith('no-untruthy-query-gate.test.ts')) continue;
    let text: string;
    try {
      text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      // A full-suite run can create a directory matching the glob; skip anything unreadable rather
      // than assuming the walk only ever yields files.
      continue;
    }
    byExt[path.extname(file)] = (byExt[path.extname(file)] ?? 0) + 1;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const comments = precedingComments(lines, i);
      if (hasBareGate(line)) {
        // Uncoerced on its own terms — either a violation, or an accounted-for exemption.
        if (comments.some((l) => EXEMPT.test(l))) exempted.push(`${file}:${i + 1}`);
        else offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  cached = { offenders, exempted, byExt };
  return cached;
}

describe('a query gated on a feature flag must coerce the flag', () => {
  it('actually scanned the app tree, BOTH extensions', () => {
    // 🔴 Per extension, not a single total. A total floor is vacuous against the likeliest glob
    // regression: `src/**` holds ~3950 `.ts` and ~1860 `.tsx`, so dropping `.tsx` from the brace
    // expansion still clears any total under 3950 — while the scan covers zero `.tsx`, which is
    // where every React Query gate in this app lives. The one regression the floor exists to catch
    // is the one a total cannot catch.
    const { byExt } = scan();
    expect(byExt['.ts'], 'the .ts half of the glob stopped matching').toBeGreaterThan(3000);
    expect(byExt['.tsx'], 'the .tsx half of the glob stopped matching').toBeGreaterThan(1500);
  });

  it('recognises the broken form', () => {
    // 🔴 The positive control, and it is the whole guard. A pattern that silently stops matching
    // passes forever, so it is exercised against text this file owns rather than against the tree —
    // where a clean result is indistinguishable from a broken regex.
    expect(hasBareGate('    enabled: features.stickers,')).toBe(true);
    expect(hasBareGate('    { enabled: features.isGreen && features.buzz }')).toBe(true);
    expect(hasBareGate('  enabled: features.stickers && showBalances,')).toBe(true);
    expect(hasBareGate('enabled:features.auctions,')).toBe(true);
    expect(
      hasBareGate('      enabled: features.cosmeticSimilarity && !!selected?.cosmetic?.id,')
    ).toBe(true);
    // 🔴 The shape a whole-value check gets wrong, and the one this guard actually found three
    // live instances of: the `!!` is present, just not on the flag. `!!currentUser && features.buzz`
    // is `undefined` whenever the flag is absent, exactly like the bare form.
    expect(hasBareGate('    enabled: features.a && !!b,')).toBe(true);
    expect(hasBareGate('    enabled: !!features.a && features.b,')).toBe(true);
    expect(hasBareGate('    enabled: !!currentUser && features.buzz,')).toBe(true);
    expect(hasBareGate('    { enabled: isActualOwner && features.articleRatingDispute }')).toBe(
      true
    );
    // 🔴 The INDIRECTION form: the flag is read into a variable and the gate is passed on as
    // `{ enabled }`, so the key scan never sees a flag. Five of the nine sites found in review had
    // this shape — one of them a line above a site the first revision had already fixed.
    expect(
      hasBareGate('  const enabled = !!currentUser && features.isGreen && features.buzz;')
    ).toBe(true);
    expect(
      hasBareGate('  const stickersEnabled = useFeatureFlags().stickers && addStickers;')
    ).toBe(true);
    expect(
      hasBareGate(
        '  const placementSurfaceEnabled = features.stickerPlacement || features.remixGallery;'
      )
    ).toBe(true);
    // The optional-chain spelling, which 20+ sites already write with `!!`.
    expect(hasBareGate('    enabled: features?.appBlocks,')).toBe(true);
    // The uncoerced member chain, i.e. the negative control for the widened lookbehind above.
    expect(hasBareGate('  const metricPrivacyEnabled = ctx.features.modelMetricPrivacy;')).toBe(
      true
    );
  });

  it('accounts for every exemption', () => {
    // 🔴 The ratchet. Without this, pasting the marker above ANY gate turns the guard green and
    // fails nothing — an opt-out nobody can see is the same as narrowing the pattern, which is the
    // one thing this guard exists to prevent.
    expect(
      scan().exempted,
      'an exemption was added or moved — it must be listed in EXEMPTED with a reason at the site'
    ).toEqual(EXEMPTED);
  });

  it('reads only the contiguous comment block above a gate', () => {
    // A marker must not exempt a WINDOW. With code between the marker and the gate, the block walk
    // stops at the code and the gate is still guarded.
    const marker = '  // no-untruthy-query-gate-exempt: reason';
    const gate = '  const enabled = features.somethingElse;';
    expect(precedingComments([marker, '  // continued', gate], 2)).toEqual([
      '  // continued',
      marker,
    ]);
    expect(precedingComments([marker, '  const other = 1;', gate], 2)).toEqual([]);
  });

  it('honours an exemption marker on the lines above', () => {
    // The opt-out exists so a site that must stay uncoerced is VISIBLE. Without it the only way to
    // keep such a site is to narrow the pattern, which silently un-guards every other site too.
    const gate = '    { enabled: features.trainingOrchestratorState && !!modelVersion.id }';
    expect(hasBareGate(gate)).toBe(true);
    expect(
      hasBareGate(gate, ['    // no-untruthy-query-gate-exempt: pending a product call'])
    ).toBe(false);
  });

  it('passes the correct form, and does not fire on a non-gate', () => {
    expect(hasBareGate('    enabled: !!features.stickers,')).toBe(false);
    expect(hasBareGate('    { enabled: !!features.model3dFeed }')).toBe(false);
    expect(hasBareGate('    enabled: !!features.stickers && showBalances,')).toBe(false);
    expect(hasBareGate('  if (!features.stickers) return null;')).toBe(false);
    expect(hasBareGate('  const canSee = features.stickers;')).toBe(false);
    // A gate-shaped name whose flag read IS coerced.
    expect(hasBareGate('  const enabled = !!currentUser && !!features.buzz;')).toBe(false);
    // A gate-shaped declaration that reads no flag at all.
    expect(hasBareGate('  const enabled = !!currentUser && canUpgrade;')).toBe(false);
    // Coerced ahead of a member chain — two real sites in model.controller.ts.
    expect(hasBareGate('  const metricPrivacyEnabled = !!ctx.features.modelMetricPrivacy;')).toBe(
      false
    );
    // `!!` over a parenthesised group coerces every read inside it. Both of these are real lines
    // this guard flagged before it understood the form.
    expect(hasBareGate('    enabled: !!(features.appBlocks || features.appListings),')).toBe(false);
    expect(
      hasBareGate('  /** The default. Mirrors `enabled:` in flipt-state features.yaml. */')
    ).toBe(false);
  });

  it('finds no bare gate in src/', () => {
    expect(
      scan().offenders,
      'a query gated on `features.X` FIRES when the flag is off — React Query resolves `enabled` as `!== false`, and an absent flag is `undefined`. Write `enabled: !!features.X`.'
    ).toEqual([]);
  });
});

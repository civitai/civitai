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
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The value of an `enabled:` key, up to the first `,` `}` or end of line. */
const ENABLED_VALUE = /\benabled:\s*([^,}\n]*)/g;
/**
 * A `features.` read that is not coerced. The lookbehind is what makes a COMPOUND work: anchoring
 * on the whole value instead would let `enabled: features.a && !!b` pass, because it contains a
 * `!!` — just not on the read that matters.
 */
const UNCOERCED = /(?<!!!)\bfeatures\./;
/** `!!(a || b)` coerces every read inside the group, so the group is removed before scanning. */
const COERCED_GROUP = /!!\([^()]*\)/g;
/** A line of prose rather than code — a jsdoc continuation, or a comment mentioning the pattern. */
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

function hasBareGate(line: string) {
  if (COMMENT_LINE.test(line)) return false;
  ENABLED_VALUE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENABLED_VALUE.exec(line))) {
    if (UNCOERCED.test(match[1].replace(COERCED_GROUP, ''))) return true;
  }
  return false;
}

function scan() {
  const files = globSync('src/**/*.{ts,tsx}', { cwd: REPO_ROOT });
  const offenders: string[] = [];
  let scanned = 0;
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
    scanned++;
    text.split(/\r?\n/).forEach((line, i) => {
      if (hasBareGate(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  return { offenders, scanned };
}

describe('a query gated on a feature flag must coerce the flag', () => {
  it('actually scanned the app tree', () => {
    // Without this, a glob that stopped matching reports a clean sweep over nothing.
    expect(scan().scanned).toBeGreaterThan(3000);
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
  });

  it('passes the correct form, and does not fire on a non-gate', () => {
    expect(hasBareGate('    enabled: !!features.stickers,')).toBe(false);
    expect(hasBareGate('    { enabled: !!features.model3dFeed }')).toBe(false);
    expect(hasBareGate('    enabled: !!features.stickers && showBalances,')).toBe(false);
    expect(hasBareGate('  if (!features.stickers) return null;')).toBe(false);
    expect(hasBareGate('  const canSee = features.stickers;')).toBe(false);
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

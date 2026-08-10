import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE NODE VERSION THE APP RUNS ON MUST BE PINNED TO AN EXACT PATCH, AND THE
 * THREE PLACES THAT DECLARE IT MUST AGREE.
 *
 * The three places, and who reads each:
 *   Dockerfile `FROM node:<tag>`   the runtime that actually serves production
 *   .nvmrc                         CI (`actions/setup-node` `node-version-file`)
 *                                  and every local `nvm use`
 *   package.json `engines.node`    the declared supported range
 *
 * WHAT THIS GUARD IS FOR — it is not tidiness. A base tag of `node:24-alpine3.24`
 * floats: the same Dockerfile, rebuilt tomorrow, can produce a different Node and
 * therefore a different V8, with no commit anywhere recording that it changed. When
 * a regression shows up after a deploy, "did our fix miss a case?" and "did the
 * engine change under us?" then have no evidence that separates them, because the
 * only artefact that moved is an image digest nobody diffed. Pinning the patch puts
 * every engine change in the history as a reviewable one-line diff.
 *
 * The agreement half matters for a different reason: CI compiles and runs the test
 * suite on whatever `.nvmrc` says, and production runs whatever the Dockerfile says.
 * When those two drift apart the suite is testing a runtime nothing ships.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE, stated rather than left implicit — a guard that
 * looks broader than it is, is worse than one that admits its edges:
 *
 *   - Only the ROOT Dockerfile. The per-service Dockerfiles under `apps/` and
 *     `containers/` build separate images on separate release cadences and float
 *     today; pinning them changes what those services run, so it belongs in its own
 *     change rather than riding along in a no-op.
 *   - `flake.nix`, which is a FOURTH declaration (the NixOS dev shell) and is on a
 *     different major. It cannot be brought into line by editing one line: the
 *     pinned nixpkgs' newest Node 24 is older than the version pinned here, so
 *     agreeing would mean moving the nixpkgs pin as well. Asserting it here would
 *     only produce a red gate nobody can fix in the change that trips it.
 *     `engines.node` is bracketed at MAJOR granularity partly for this reason: a
 *     patch-exact floor would be violated by every dev shell on day one.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCKERFILE = 'Dockerfile';

/**
 * How many `FROM node:` stages the root Dockerfile has today (deps + runner), and
 * how many `FROM` directives it has in TOTAL (those two, plus `FROM deps` and
 * `FROM scratch`).
 *
 * Together these are the controls that stop the whole file passing vacuously. Every
 * verdict below is universally quantified over the tags the extractor returns — and
 * a universally quantified assertion over an EMPTY list is true.
 *
 * The node-stage count ALONE is not enough, and the gap was real rather than
 * theoretical: it is an equality on the MATCHED count, so a node stage the extractor
 * cannot see leaves it sitting at 2 and nothing anywhere notices. Measured on the
 * previous pattern: with `from node:24-alpine3.24 AS sneaky` appended to this very
 * Dockerfile, all seven tests in this file passed.
 *
 * The TOTAL directive count is the half that closes it. A stage added in ANY
 * spelling moves the total, whether or not the extractor understood it — so an
 * added-but-unmatched stage is a red, not a silent pass. It is independent of the
 * coverage control below (which compares two readers of the same file) precisely so
 * that a blind spot shared by both readers still trips something.
 */
const EXPECTED_NODE_STAGES = 2;
const EXPECTED_FROM_DIRECTIVES = 4;

/**
 * `FROM node:<tag>`, tolerating the spellings Docker accepts and a reader writing
 * this pattern by eye does not:
 *
 *   - flags between `FROM` and the image reference (`FROM --platform=$BUILDPLATFORM
 *     node:...`), the shape a build-matrix change is likely to introduce;
 *   - a LOWERCASE directive (`from node:...`) — Dockerfile directives are
 *     case-insensitive. Verified by building one: it succeeds, with only a
 *     `ConsistentInstructionCasing` warning;
 *   - LEADING WHITESPACE (`  FROM node:...`) — also builds, no warning at all.
 *
 * The last two were live holes, not hypotheticals: see the measurement quoted above.
 *
 * The `i` flag necessarily makes `node:` case-insensitive as well. That reach is
 * DEFENSIVE rather than required — an uppercase image reference is not legal
 * (`FROM ALPINE:3.20` fails to build with `repository name ... must be lowercase`),
 * so the only thing the extra reach can match is a stage that could never build,
 * which is worth naming rather than skipping.
 *
 * `[ \t]` rather than `\s`: under the `m` flag `\s` spans newlines, so a bare `FROM`
 * ending one line could join a `node:` beginning the next into a match for a stage
 * that does not exist.
 *
 * Deliberately NOT matching a digest-pinned `node@sha256:...`: that form is already
 * immutable, so it does not have the defect this guard exists for, and silently
 * accepting it under a rule written for tags would be a lie about what was checked.
 * If the repo ever moves to digest pins, this guard should be rewritten, not widened.
 * The controls below detect that case explicitly and say so, so that a move to
 * digests reads as "out of scope", not as "the pattern is broken".
 */
const FROM_NODE_TAG = /^[ \t]*FROM[ \t]+(?:--\S+[ \t]+)*node:(\S+)/gim;

/**
 * EVERY `FROM` directive, whatever it builds on — a deliberately DUMBER second
 * reader whose only job is to disagree with FROM_NODE_TAG.
 *
 * It recognises the directive and then splits the remainder into tokens, instead of
 * encoding the image reference's shape into the pattern, so the two readers do not
 * share a blind spot in how an image reference is recognised. When a `FROM node:`
 * stage exists that the extractor above did not return, the two disagree and the
 * coverage control names the offending reference.
 */
const ANY_FROM = /^[ \t]*FROM[ \t]+(.+)$/gim;

/** An exact patch pin: `24.19.0-alpine3.24`. NOT `24-alpine3.24`, NOT `24.19-alpine3.24`. */
const EXACT_PATCH_TAG = /^(\d+\.\d+\.\d+)(-\S+)?$/;

/**
 * `>=X.Y.Z <W` — a floor and a major ceiling, which is the shape asserted below.
 *
 * The ceiling may equivalently be written `<W.0.0`, which denotes exactly the same
 * set of versions; rejecting one spelling of a range while accepting the other made
 * the failure read as a real violation when nothing was wrong. Nothing looser is
 * accepted: `<W.0.1` is NOT the same range — it admits `W.0.0`, a major that is
 * neither built nor tested — so it must keep failing.
 */
const ENGINES_RANGE = /^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)(?:\.0\.0)?$/;

function extractNodeTags(dockerfile: string): string[] {
  return [...dockerfile.matchAll(FROM_NODE_TAG)].map((m) => m[1]);
}

/**
 * The image reference of every `FROM` directive, found without FROM_NODE_TAG:
 * the first token after the directive that is not a `--flag`.
 */
function extractFromRefs(dockerfile: string): string[] {
  return [...dockerfile.matchAll(ANY_FROM)].map(
    (m) =>
      m[1]
        .trim()
        .split(/[ \t]+/)
        .filter((token) => !token.startsWith('--'))[0] ?? ''
  );
}

/**
 * The tags that are NOT exact patch pins — i.e. exactly what the verdict below
 * forbids.
 *
 * Split out as a named function so the verdict's rule is driven over a fixture in a
 * control, not only over whatever the repo happens to contain today. Asserted only
 * against live data, the rule could be neutered to a constant `true` and stay green
 * forever, because the live data does not violate it.
 */
function floatingTags(tags: string[]): string[] {
  return tags.filter((tag) => !EXACT_PATCH_TAG.test(tag));
}

/**
 * The version a tag declares, WITHOUT re-testing whether it is a proper pin.
 *
 * Deliberately lenient, and the reason is worth stating: if these two helpers also
 * enforced the pin rule, then unpinning the Dockerfile would red three tests at once
 * — and the two extra failures would be about `undefined` and `NaN` rather than
 * about the float. A mutant should die to the guard that OWNS it, with that guard's
 * message, and stay silent everywhere else.
 */
function versionOf(tag: string | undefined): string | undefined {
  return tag?.match(EXACT_PATCH_TAG)?.[1] ?? tag;
}

function majorOf(tag: string | undefined): number {
  return Number(tag?.match(/^(\d+)/)?.[1]);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const dockerfileText = read(DOCKERFILE);
const nodeTags = extractNodeTags(dockerfileText);
const nvmrc = read('.nvmrc').trim();
const enginesNode: unknown = JSON.parse(read('package.json'))?.engines?.node;

/** Every `FROM` image reference, and the `node:` subset, as the DUMB reader sees them. */
const fromRefs = extractFromRefs(dockerfileText);
const independentNodeTags = fromRefs
  .filter((ref) => /^node:/i.test(ref))
  .map((ref) => ref.slice('node:'.length));
const digestPinnedNodeRefs = fromRefs.filter((ref) => /^node@/i.test(ref));

/**
 * Appended to the messages that go strange when the extractor returned nothing.
 *
 * Without it, moving both stages to `node@sha256:...` — which is STRONGER than a tag
 * pin, not weaker — reds several tests with wording that points at a broken pattern.
 * This is message text only: it changes no assertion, it just stops the failure
 * misdiagnosing its own input.
 */
function formatEmptyExtractionNote(tags: string[], digestRefs: string[]): string {
  if (tags.length > 0) return '';
  const digests = digestRefs.length
    ? ` The Dockerfile DOES have ${digestRefs.length} digest-pinned node ` +
      `stage(s) (${digestRefs.join(', ')}). A digest is a STRONGER pin than an ` +
      `exact tag, so this is not a violation and not a bug in the pattern — this guard is ` +
      `written for tags and does not read digests. Moving the image to digests means ` +
      `rewriting this guard, not widening it.`
    : '';
  return (
    ` NOTE: the extractor returned NO node tags at all, so the versions quoted in this ` +
    `message are absent rather than wrong — read the CONTROL failures first.${digests}`
  );
}

const emptyExtractionNote = () => formatEmptyExtractionNote(nodeTags, digestPinnedNodeRefs);

describe('node version is pinned and consistent across the repo', () => {
  // ---------------------------------------------------------------------------
  // Controls first. Everything below quantifies over `nodeTags`, and an empty
  // list satisfies all of it — so prove the extractor found the stages, prove it
  // did not MISS any, and prove it can distinguish a pinned tag from a floating
  // one, before reading any verdict.
  //
  // The evasions these controls exist for are the ones Docker accepts and a
  // pattern written by eye does not: a LOWERCASE `from node:` directive, and a
  // directive with LEADING WHITESPACE. Both were verified to build, and both
  // were verified to slip an unpinned stage past the previous pattern with all
  // seven tests still green. (Not, as an earlier version of this comment
  // claimed, a double space after `FROM` — `[ \t]+` has always handled runs of
  // spaces and tabs, and citing it here sent the reader away from the two gaps
  // that were actually open.)
  // ---------------------------------------------------------------------------
  it('CONTROL: the extractor finds every node stage in the root Dockerfile', () => {
    expect(
      nodeTags.length,
      `Expected ${EXPECTED_NODE_STAGES} \`FROM node:\` stages in ${DOCKERFILE}, found ` +
        `${nodeTags.length}. If a stage was added, raise EXPECTED_NODE_STAGES so the new ` +
        `stage is covered. If this dropped to 0, FROM_NODE_TAG no longer matches and every ` +
        `assertion in this file is passing over an empty list.${emptyExtractionNote()}`
    ).toBe(EXPECTED_NODE_STAGES);
  });

  it('CONTROL: every FROM directive in the root Dockerfile is accounted for', () => {
    expect(
      fromRefs.length,
      `${DOCKERFILE} has ${fromRefs.length} \`FROM\` directives (${fromRefs.join(', ')}); this ` +
        `guard was written against ${EXPECTED_FROM_DIRECTIVES}. A stage was added or removed. ` +
        `This control is deliberately separate from the node-stage count: that one counts what ` +
        `the extractor MATCHED, so a node stage written in a spelling the extractor cannot see ` +
        `leaves it unchanged and unnoticed. This one moves for any stage in any spelling. If ` +
        `the new stage is a node stage, make sure it appears in the coverage control below and ` +
        `raise EXPECTED_NODE_STAGES too; then raise EXPECTED_FROM_DIRECTIVES.`
    ).toBe(EXPECTED_FROM_DIRECTIVES);
  });

  it('CONTROL: the extractor sees every node stage a dumber reader can find', () => {
    // Two readers of the same file, built differently on purpose: FROM_NODE_TAG
    // encodes the image reference's shape in the pattern, extractFromRefs finds
    // the directive and then tokenises. When they disagree, the extractor has a
    // blind spot — which is exactly how a floating stage stayed invisible.
    expect(
      nodeTags,
      `An independent scan of ${DOCKERFILE} finds \`FROM node:\` stages the extractor did not ` +
        `return. Independent scan: [${independentNodeTags.join(', ')}]. Extractor: ` +
        `[${nodeTags.join(', ')}]. FROM_NODE_TAG is blind to a spelling that is in the file, so ` +
        `the verdicts below are not covering every stage.`
    ).toEqual(independentNodeTags);
  });

  it('CONTROL: the extractor reads tags, and only node tags, out of a Dockerfile', () => {
    // Drive the real function over a fixture rather than re-implementing its
    // rules. The `FROM deps` / `FROM scratch` lines are the ones a sloppier
    // pattern would sweep up; `python:3.12` is the cross-image negative.
    const fixture = [
      'FROM node:24.19.0-alpine3.24 AS deps',
      'RUN echo not-a-from-line node:99-alpine',
      'FROM deps AS builder',
      'FROM scratch AS maps',
      'FROM --platform=$BUILDPLATFORM node:22-alpine AS other',
      'FROM python:3.12 AS unrelated',
    ].join('\n');
    expect(extractNodeTags(fixture)).toEqual(['24.19.0-alpine3.24', '22-alpine']);
    expect(extractNodeTags('FROM scratch\nFROM python:3.12\n')).toEqual([]);
  });

  it('REGRESSION: a LOWERCASE `from node:` stage is not invisible to the extractor', () => {
    // Docker directives are case-insensitive: this builds (only a
    // ConsistentInstructionCasing warning), and under the previous `/gm` pattern
    // it was extracted as nothing at all — an unpinned stage, seven green tests.
    expect(
      extractNodeTags('from node:24-alpine3.24 AS sneaky\n'),
      'a lowercase `from node:` directive builds, so it must be extracted'
    ).toEqual(['24-alpine3.24']);
    expect(extractNodeTags('From node:24-alpine3.24 AS mixed\n')).toEqual(['24-alpine3.24']);
    // …and in the position it would really appear: appended after real stages.
    expect(
      extractNodeTags('FROM node:24.19.0-alpine3.24 AS deps\nfrom node:24-alpine3.24 AS sneaky\n')
    ).toEqual(['24.19.0-alpine3.24', '24-alpine3.24']);
  });

  it('REGRESSION: an INDENTED `FROM node:` stage is not invisible to the extractor', () => {
    // Leading whitespace before a directive is legal and builds without even a
    // warning; the previous pattern anchored hard at `^FROM` and missed it.
    expect(
      extractNodeTags('  FROM node:24-alpine3.24 AS indented\n'),
      'an indented FROM directive builds, so it must be extracted'
    ).toEqual(['24-alpine3.24']);
    expect(extractNodeTags('\tfrom node:24-alpine3.24 AS both\n')).toEqual(['24-alpine3.24']);
    expect(
      extractNodeTags('FROM node:24.19.0-alpine3.24 AS deps\n\t  FROM node:22-alpine AS tabbed\n')
    ).toEqual(['24.19.0-alpine3.24', '22-alpine']);
  });

  it('REGRESSION: widening for those two did not start matching non-directives', () => {
    // The `i` flag and the leading-`[ \t]*` are the widenings; these are the
    // lines in the real Dockerfile that sit closest to them.
    expect(extractNodeTags('# FROM node:24-alpine3.24 AS commented-out\n')).toEqual([]);
    expect(extractNodeTags('  # from node:24-alpine3.24\n')).toEqual([]);
    expect(extractNodeTags('COPY --from=deps /app/node_modules ./node_modules\n')).toEqual([]);
    expect(extractNodeTags('RUN echo "derived from node:99-alpine"\n')).toEqual([]);
    // `\s` would span the newline and invent a stage that is not there.
    expect(extractNodeTags('FROM\nnode:24-alpine3.24\n')).toEqual([]);
  });

  it('CONTROL: the failure note diagnoses an empty extraction instead of blaming the pattern', () => {
    // Message text, so nothing else in this file can catch it going wrong — which
    // is exactly why it gets its own assertion rather than being trusted.
    expect(formatEmptyExtractionNote(['24.19.0-alpine3.24'], [])).toBe('');
    expect(formatEmptyExtractionNote([], [])).toContain('returned NO node tags');
    const digestNote = formatEmptyExtractionNote([], ['node@sha256:abc', 'node@sha256:def']);
    expect(digestNote).toContain('2 digest-pinned node stage(s)');
    expect(digestNote).toContain('STRONGER pin');
    // A digest-pinned tree must not be told its pattern is broken.
    expect(digestNote).toContain('not a bug in the pattern');
  });

  it('CONTROL: the dumb second reader finds every FROM, and only FROMs', () => {
    // If this reader were blind in the same places as FROM_NODE_TAG, the
    // coverage control comparing them would agree vacuously.
    const fixture = [
      'FROM node:24.19.0-alpine3.24 AS deps',
      'from node:24-alpine3.24 AS sneaky',
      '  FROM scratch AS maps',
      'FROM --platform=$BUILDPLATFORM node:22-alpine AS other',
      '# FROM node:1-commented',
      'COPY --from=builder /app/x ./x',
    ].join('\n');
    expect(extractFromRefs(fixture)).toEqual([
      'node:24.19.0-alpine3.24',
      'node:24-alpine3.24',
      'scratch',
      'node:22-alpine',
    ]);
  });

  it('CONTROL: the pin predicate rejects the floating forms it exists to catch', () => {
    // The exact tags this repo has used. `24-alpine3.24` is what was there before
    // the pin, and is the mutation this whole file is meant to fail on.
    expect(EXACT_PATCH_TAG.test('24.19.0-alpine3.24')).toBe(true);
    expect(EXACT_PATCH_TAG.test('24.19.0')).toBe(true);
    expect(EXACT_PATCH_TAG.test('24-alpine3.24')).toBe(false);
    expect(EXACT_PATCH_TAG.test('24.19-alpine3.24')).toBe(false);
    expect(EXACT_PATCH_TAG.test('lts-alpine')).toBe(false);
    expect(EXACT_PATCH_TAG.test('latest')).toBe(false);
    // The `$` anchor, which nothing else here exercises: without it the predicate
    // accepts anything that merely BEGINS with a patch version.
    expect(EXACT_PATCH_TAG.test('24.19.0.1')).toBe(false);
    expect(EXACT_PATCH_TAG.test('24.19.0 24.20.0')).toBe(false);
  });

  it('CONTROL: the pin verdict picks the floating tags OUT of a mixed list', () => {
    // The verdict below applies this rule to whatever the Dockerfile contains, and
    // the Dockerfile does not violate it — so on live data alone the rule could be
    // replaced by a constant `true` and never be noticed. Drive it over a fixture
    // that DOES violate it.
    expect(floatingTags(['24.19.0-alpine3.24', '24.19.0'])).toEqual([]);
    expect(floatingTags(['24.19.0-alpine3.24', '24-alpine3.24', 'latest'])).toEqual([
      '24-alpine3.24',
      'latest',
    ]);
  });

  it('CONTROL: the engines-range predicate accepts both spellings of one ceiling, and nothing looser', () => {
    expect(ENGINES_RANGE.test('>=24.0.0 <25')).toBe(true);
    // Identical set of versions, so identical verdict. Rejecting this spelling
    // reported a violation where there was none.
    expect(ENGINES_RANGE.test('>=24.0.0 <25.0.0')).toBe(true);
    // NOT identical: `<25.0.1` admits 25.0.0, a major nobody builds or tests.
    expect(ENGINES_RANGE.test('>=24.0.0 <25.0.1')).toBe(false);
    expect(ENGINES_RANGE.test('>=24.0.0 <25.1.0')).toBe(false);
    expect(ENGINES_RANGE.test('>=24.0.0')).toBe(false);
    expect(ENGINES_RANGE.test('^24.0.0')).toBe(false);
    expect(ENGINES_RANGE.test('>=24 <25')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Verdicts.
  // ---------------------------------------------------------------------------
  it('every root Dockerfile node stage pins an EXACT patch version', () => {
    // Assert the population FIRST. This verdict used to be a loop, and a loop over
    // an empty list is green — so an extractor that returned nothing produced the
    // repo's strongest-sounding pass while checking no stage at all.
    expect(
      nodeTags.length,
      `This verdict examined NO node tags — it did not pass, it never ran. Read the ` +
        `CONTROL failures above.${emptyExtractionNote()}`
    ).toBe(EXPECTED_NODE_STAGES);

    const floating = floatingTags(nodeTags);
    expect(
      floating,
      `${DOCKERFILE} has ${floating.map((tag) => `\`FROM node:${tag}\``).join(', ')}, which ` +
        `does not pin a patch version. A tag like \`24-alpine3.24\` resolves to whatever the ` +
        `newest 24.x is at BUILD time, so production's Node — and its V8 — can change with no ` +
        `commit recording it, which makes an engine change indistinguishable from an ` +
        `application regression. Write the full version, e.g. \`node:24.19.0-alpine3.24\`.`
    ).toEqual([]);
  });

  it('all root Dockerfile node stages use the SAME tag', () => {
    expect(
      [...new Set(nodeTags)],
      `${DOCKERFILE} builds its stages on different node tags (${nodeTags.join(', ')}). The ` +
        `build stage and the runtime stage must be the same engine, or the app is compiled ` +
        `against one Node and executed on another.${emptyExtractionNote()}`
    ).toHaveLength(1);
  });

  it('.nvmrc matches the Dockerfile pin', () => {
    const version = versionOf(nodeTags[0]);
    expect(
      nvmrc,
      `.nvmrc says ${nvmrc}, the ${DOCKERFILE} base image is ${version}. CI installs the ` +
        `.nvmrc version and runs the suite on it; production runs the Dockerfile version. ` +
        `While these differ, the suite is testing a runtime that never ships.` +
        `${emptyExtractionNote()}`
    ).toBe(version);
  });

  it('engines.node brackets exactly the major that is pinned', () => {
    const pinnedMajor = majorOf(nodeTags[0]);
    expect(typeof enginesNode, 'package.json has no engines.node').toBe('string');

    const parsed = String(enginesNode).match(ENGINES_RANGE);
    expect(
      parsed,
      `engines.node is "${String(enginesNode)}", which is not of the form ">=X.Y.Z <W" (the ` +
        `exclusive ceiling may equivalently be written "<W.0.0"; anything else — "<W.0.1", ` +
        `"<W.1.0" — denotes a DIFFERENT range that admits major W, so it is rejected on ` +
        `purpose rather than on spelling). An open-ended range permits a major nobody builds, ` +
        `tests or runs.`
    ).not.toBeNull();

    const floorMajor = Number(parsed?.[1]);
    const ceiling = Number(parsed?.[4]);
    expect(
      floorMajor,
      `engines.node starts at major ${floorMajor} but the image pins ` +
        `${pinnedMajor}.${emptyExtractionNote()}`
    ).toBe(pinnedMajor);
    expect(
      ceiling,
      `engines.node permits up to major ${ceiling}; the only major that is built and tested ` +
        `is ${pinnedMajor}, so the exclusive ceiling must be ${pinnedMajor + 1}.`
    ).toBe(pinnedMajor + 1);
  });
});

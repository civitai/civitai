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
 * How many `FROM node:` stages the root Dockerfile has today (deps + runner).
 *
 * This is a POPULATION FLOOR, and it is the control that stops the whole file
 * passing vacuously. Every assertion below is universally quantified over the tags
 * the extractor returns — and a universally quantified assertion over an EMPTY list
 * is true. A regex that stops matching (someone writes `FROM  node:...`, or adds a
 * `--platform` flag in a shape the pattern misses) would otherwise turn this suite
 * green while checking nothing at all.
 */
const EXPECTED_NODE_STAGES = 2;

/**
 * `FROM node:<tag>`, tolerating flags between `FROM` and the image reference
 * (`FROM --platform=$BUILDPLATFORM node:...`) because that is the one shape a
 * build-matrix change is likely to introduce.
 *
 * Deliberately NOT matching a digest-pinned `node@sha256:...`: that form is already
 * immutable, so it does not have the defect this guard exists for, and silently
 * accepting it under a rule written for tags would be a lie about what was checked.
 * If the repo ever moves to digest pins, this guard should be rewritten, not widened.
 */
const FROM_NODE_TAG = /^FROM\s+(?:--\S+\s+)*node:(\S+)/gm;

/** An exact patch pin: `24.19.0-alpine3.24`. NOT `24-alpine3.24`, NOT `24.19-alpine3.24`. */
const EXACT_PATCH_TAG = /^(\d+\.\d+\.\d+)(-\S+)?$/;

/** `>=X.Y.Z <W` — a floor and a major ceiling, which is the shape asserted below. */
const ENGINES_RANGE = /^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)$/;

function extractNodeTags(dockerfile: string): string[] {
  return [...dockerfile.matchAll(FROM_NODE_TAG)].map((m) => m[1]);
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

describe('node version is pinned and consistent across the repo', () => {
  // ---------------------------------------------------------------------------
  // Controls first. Everything below quantifies over `nodeTags`, and an empty
  // list satisfies all of it — so prove the extractor found the stages, and
  // prove it can distinguish a pinned tag from a floating one, before reading
  // any verdict.
  // ---------------------------------------------------------------------------
  it('CONTROL: the extractor finds every node stage in the root Dockerfile', () => {
    expect(
      nodeTags.length,
      `Expected ${EXPECTED_NODE_STAGES} \`FROM node:\` stages in ${DOCKERFILE}, found ` +
        `${nodeTags.length}. If a stage was added, raise EXPECTED_NODE_STAGES so the new ` +
        `stage is covered. If this dropped to 0, FROM_NODE_TAG no longer matches and every ` +
        `assertion in this file is passing over an empty list.`
    ).toBe(EXPECTED_NODE_STAGES);
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

  it('CONTROL: the pin predicate rejects the floating forms it exists to catch', () => {
    // The exact tags this repo has used. `24-alpine3.24` is what was there before
    // the pin, and is the mutation this whole file is meant to fail on.
    expect(EXACT_PATCH_TAG.test('24.19.0-alpine3.24')).toBe(true);
    expect(EXACT_PATCH_TAG.test('24.19.0')).toBe(true);
    expect(EXACT_PATCH_TAG.test('24-alpine3.24')).toBe(false);
    expect(EXACT_PATCH_TAG.test('24.19-alpine3.24')).toBe(false);
    expect(EXACT_PATCH_TAG.test('lts-alpine')).toBe(false);
    expect(EXACT_PATCH_TAG.test('latest')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Verdicts.
  // ---------------------------------------------------------------------------
  it('every root Dockerfile node stage pins an EXACT patch version', () => {
    for (const tag of nodeTags) {
      expect(
        EXACT_PATCH_TAG.test(tag),
        `${DOCKERFILE} has \`FROM node:${tag}\`, which does not pin a patch version. A tag ` +
          `like \`24-alpine3.24\` resolves to whatever the newest 24.x is at BUILD time, so ` +
          `production's Node — and its V8 — can change with no commit recording it, which ` +
          `makes an engine change indistinguishable from an application regression. Write ` +
          `the full version, e.g. \`node:24.19.0-alpine3.24\`.`
      ).toBe(true);
    }
  });

  it('all root Dockerfile node stages use the SAME tag', () => {
    expect(
      [...new Set(nodeTags)],
      `${DOCKERFILE} builds its stages on different node tags (${nodeTags.join(', ')}). The ` +
        `build stage and the runtime stage must be the same engine, or the app is compiled ` +
        `against one Node and executed on another.`
    ).toHaveLength(1);
  });

  it('.nvmrc matches the Dockerfile pin', () => {
    const version = versionOf(nodeTags[0]);
    expect(
      nvmrc,
      `.nvmrc says ${nvmrc}, the ${DOCKERFILE} base image is ${version}. CI installs the ` +
        `.nvmrc version and runs the suite on it; production runs the Dockerfile version. ` +
        `While these differ, the suite is testing a runtime that never ships.`
    ).toBe(version);
  });

  it('engines.node brackets exactly the major that is pinned', () => {
    const pinnedMajor = majorOf(nodeTags[0]);
    expect(typeof enginesNode, 'package.json has no engines.node').toBe('string');

    const parsed = String(enginesNode).match(ENGINES_RANGE);
    expect(
      parsed,
      `engines.node is "${String(enginesNode)}", which is not of the form ">=X.Y.Z <W". An ` +
        `open-ended range permits a major nobody builds, tests or runs.`
    ).not.toBeNull();

    const floorMajor = Number(parsed?.[1]);
    const ceiling = Number(parsed?.[4]);
    expect(
      floorMajor,
      `engines.node starts at major ${floorMajor} but the image pins ${pinnedMajor}.`
    ).toBe(pinnedMajor);
    expect(
      ceiling,
      `engines.node permits up to major ${ceiling}; the only major that is built and tested ` +
        `is ${pinnedMajor}, so the exclusive ceiling must be ${pinnedMajor + 1}.`
    ).toBe(pinnedMajor + 1);
  });
});

import { readFileSync, statSync } from 'fs';
import { globSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { uniq } from 'lodash-es';

/**
 * `retractPublicBlobs` asks the image-cache service to destroy the SHARED STORED OBJECT behind an
 * image, not just its derived variants. That object is content-addressed, so it is shared by every
 * byte-identical image of every owner: setting this removes the full-resolution original for all of
 * them, their database rows survive, and nothing in this codebase can enumerate them (no
 * content-hash key is stored, and `pHash` is a perceptual — not byte-identity — hash).
 *
 * It is therefore a cross-account destructive capability, and the whole design is that exactly one
 * flow can reach it: the moderation takedown of blocked media. That claim is about a SET OF CALL
 * SITES, so no behavioural test can pin it — a test asserts what the sites it knows about do, and
 * the risk is the site nobody thought to write a test for.
 *
 * This guard is that ledger, and it fails in BOTH directions:
 *   - the set GROWS — a new flow starts asking for retraction, deliberately or by copy-paste;
 *   - the set SHRINKS — the moderation flow silently stops asking, and takedowns go back to
 *     leaving the bytes in place with nothing to say so.
 *
 * 🔴 It counts CALL SITES, not files, and it walks the whole workspace, not just `src/`. Both are
 * scars. Ledgering file NAMES over a walk rooted at `src/` left two ways to add a retracting call
 * with the guard green: append a second one to a file already on the ledger — `image-ingestion.ts`
 * hosts
 * several jobs, so that is exactly where a copy-paste lands — or put it anywhere outside `src/`,
 * which is most of this repo (`apps/`, `packages/`, `scripts/`). Both were demonstrated against the
 * previous version of this file.
 *
 * A legitimate change to either set edits the ledger below, in the same commit, with a reason.
 * That is the point: adding a caller should require saying out loud that you are adding one.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The identifier every layer of the plumbing spells the same way. */
const OPTION = 'retractPublicBlobs';
/**
 * Setting it ON. The plumbing mentions the name; only a caller with intent writes `: true`.
 * Global, because the number of sites in a file is the thing being ledgered.
 */
const SET_TRUE = /retractPublicBlobs:\s*true/g;

/** Every top-level directory that holds first-party code. Not `src` alone — see the header. */
const SCAN_ROOTS = ['src', 'apps', 'packages', 'scripts', 'test', 'tests'];

/**
 * The roots the walk MUST have reached, read out of `pnpm-workspace.yaml` rather than restated
 * here. That independence is the whole point: a control derived from `SCAN_ROOTS` is satisfied by
 * editing `SCAN_ROOTS`, so narrowing the walk back to `src` would pass its own breadth check. The
 * workspace file is a different source of truth — it says where this repo keeps first-party code —
 * so dropping `apps` or `packages` from the walk fails against it.
 */
function workspaceRoots(): string[] {
  const yaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  // `.` is the root package, whose own code is `src`; the rest are `<root>/*` globs.
  return uniq(globs.filter((g) => g !== '.').map((g) => g.split('/')[0]));
}
const EXTENSIONS = 'ts,tsx,mts,cts,js,mjs,cjs,jsx,svelte';
/** Dependency trees and build output: not authored here, and each workspace package has its own. */
const NOT_SOURCE = /(^|\/)(node_modules|dist|build|\.next|\.svelte-kit|coverage|\.turbo|out)(\/|$)/;

/**
 * Every non-test source file allowed to mention the option at all — the plumbing plus the one
 * caller. `image.service.ts` declares it, threads it and builds the query parameter;
 * `image-ingestion.ts` is the moderation takedown that asks for it.
 */
const LEDGER_MENTIONS = [
  'src/server/jobs/image-ingestion.ts',
  'src/server/services/image.service.ts',
];

/**
 * 🔴 The narrow claim, and the one that matters: every place that turns retraction ON, and how
 * many times each does it. `remove-blocked-images` deletes media that a moderator blocked, that is
 * still blocked, that is not awaiting AI re-verification, that did not arrive from a user's own
 * account deletion, and that has sat out the retention window. It is the only one, and it asks
 * once.
 */
const LEDGER_SETTERS = ['src/server/jobs/image-ingestion.ts ×1'];

type Scan = {
  mentions: string[];
  setters: string[];
  scanned: number;
  scannedByRoot: Record<string, number>;
};

let cached: Scan | undefined;

/**
 * Memoised: the walk is ~8k files and every test below needs the same answer. Still called from
 * INSIDE the tests, never at module scope — a throw at module scope would collect zero tests and
 * the guard would vanish from the run instead of failing it.
 */
function scan(): Scan {
  if (cached) return cached;
  // One glob per root rather than a `{a,b,c}` brace list. A brace holding a SINGLE alternative is
  // not expanded, so a one-root list silently matches the literal directory `{src}` and the walk
  // returns nothing — a reassuring zero that would make every claim below vacuous.
  const files = SCAN_ROOTS.flatMap((root) =>
    globSync(`${root}/**/*.{${EXTENSIONS}}`, {
      cwd: REPO_ROOT,
      exclude: (p) => NOT_SOURCE.test(p.replace(/\\/g, '/')),
    })
  );
  const mentions: string[] = [];
  const setters: string[] = [];
  // Keyed on what the walk actually YIELDED, never seeded from `SCAN_ROOTS`: a root that was not
  // walked has to come back absent, not as a zero the constant put there.
  const scannedByRoot: Record<string, number> = {};
  let scanned = 0;
  for (const rel of files) {
    const file = rel.replace(/\\/g, '/');
    // Tests necessarily talk about the option; they are not call sites in a running app.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const abs = path.join(REPO_ROOT, rel);
    // A full-suite run can create directories mid-walk; one matching the glob would otherwise
    // reach readFileSync as EISDIR and take the guard down for an unrelated reason.
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    scanned++;
    const root = file.slice(0, file.indexOf('/'));
    scannedByRoot[root] = (scannedByRoot[root] ?? 0) + 1;
    const src = readFileSync(abs, 'utf8');
    if (!src.includes(OPTION)) continue;
    mentions.push(file);
    const count = src.match(SET_TRUE)?.length ?? 0;
    if (count > 0) setters.push(`${file} ×${count}`);
  }
  cached = { mentions: mentions.sort(), setters: setters.sort(), scanned, scannedByRoot };
  return cached;
}

describe('no-unmoderated-blob-retraction', () => {
  // POSITIVE CONTROL. Everything below is a claim about a set of files. If the walk returns
  // nothing — a moved root, a broken glob — every claim is vacuously satisfied and the guard
  // reports success having read no code at all.
  it('actually scanned the source tree', () => {
    const { scanned } = scan();
    expect(scanned).toBeGreaterThan(2000);
  });

  // Second positive control, on the BREADTH of the walk rather than its size. `src` alone is
  // ~6,000 files, so the floor above is satisfied while `apps`, `packages` and `scripts` are
  // invisible — which is precisely the hole a setter outside `src` walked through. The required
  // set comes from `pnpm-workspace.yaml`, not from `SCAN_ROOTS`, so narrowing the walk is red
  // rather than self-approving.
  it('reaches every first-party root the workspace declares', () => {
    const { scannedByRoot } = scan();
    const required = workspaceRoots();
    // Guards the guard: an unparsed or moved workspace file would make the check below vacuous.
    expect(required.length, 'no workspace roots parsed out of pnpm-workspace.yaml').toBeGreaterThan(
      0
    );
    const missed = required.filter((r) => !scannedByRoot[r]);
    expect(
      missed,
      'these workspace roots contributed no files — the walk cannot see a retracting call ' +
        'placed there'
    ).toEqual([]);
  });

  // Third positive control, on the PATTERN rather than the walk. A rename of the option would
  // empty both sets, and "no file sets it" is indistinguishable from "the guard cannot see it".
  it('can still find the option it is guarding', () => {
    const { mentions } = scan();
    expect(
      mentions.length,
      `no source file mentions \`${OPTION}\` — if it was renamed, rename it here too`
    ).toBeGreaterThan(0);
  });

  it('lets exactly one call site ask for retraction', () => {
    const { setters } = scan();
    expect(
      setters,
      'Retraction destroys the shared stored object for every byte-identical image of every ' +
        'owner. Only a moderation takedown may request it. The count after each file is part of ' +
        'the claim: a SECOND call site in an already-listed file is the copy-paste this exists ' +
        'to catch. If you are adding a flow, say why here; if the moderation flow has stopped ' +
        'asking, that is a silent loss of the capability.'
    ).toEqual(LEDGER_SETTERS);
  });

  it('keeps the plumbing that carries it to exactly the known files', () => {
    const { mentions } = scan();
    expect(
      mentions,
      'A new file mentioning this option is a new way to reach a cross-account destructive ' +
        'capability. Add it here deliberately, or route the call through image.service.'
    ).toEqual(LEDGER_MENTIONS);
  });
});

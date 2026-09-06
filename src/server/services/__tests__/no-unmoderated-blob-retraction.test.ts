import { readFileSync, statSync } from 'fs';
import { globSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

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
 * A legitimate change to either set edits the ledger below, in the same commit, with a reason.
 * That is the point: adding a caller should require saying out loud that you are adding one.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The identifier every layer of the plumbing spells the same way. */
const OPTION = 'retractPublicBlobs';
/** Setting it ON. The plumbing mentions the name; only a caller with intent writes `: true`. */
const SET_TRUE = /retractPublicBlobs:\s*true/;

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
 * 🔴 The narrow claim, and the one that matters: the ONLY flow that turns retraction ON.
 * `remove-blocked-images` deletes media that a moderator blocked, that is still blocked, that is
 * not awaiting AI re-verification, and that has sat out the retention window.
 */
const LEDGER_SETTERS = ['src/server/jobs/image-ingestion.ts'];

function scan() {
  const files = globSync('src/**/*.{ts,tsx}', { cwd: REPO_ROOT });
  const mentions: string[] = [];
  const setters: string[] = [];
  let scanned = 0;
  for (const rel of files) {
    const file = rel.replace(/\\/g, '/');
    // Tests necessarily talk about the option; they are not call sites in a running app.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const abs = path.join(REPO_ROOT, rel);
    // A full-suite run can create directories under `src/` mid-walk; one matching the glob would
    // otherwise reach readFileSync as EISDIR and take the guard down for an unrelated reason.
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    scanned++;
    const src = readFileSync(abs, 'utf8');
    if (!src.includes(OPTION)) continue;
    mentions.push(file);
    if (SET_TRUE.test(src)) setters.push(file);
  }
  return { mentions: mentions.sort(), setters: setters.sort(), scanned };
}

describe('no-unmoderated-blob-retraction', () => {
  // POSITIVE CONTROL. Everything below is a claim about a set of files. If the walk returns
  // nothing — a moved root, a broken glob — every claim is vacuously satisfied and the guard
  // reports success having read no code at all.
  it('actually scanned the source tree', () => {
    const { scanned } = scan();
    expect(scanned).toBeGreaterThan(2000);
  });

  // Second positive control, on the PATTERN rather than the walk. A rename of the option would
  // empty both sets, and "no file sets it" is indistinguishable from "the guard cannot see it".
  it('can still find the option it is guarding', () => {
    const { mentions } = scan();
    expect(
      mentions.length,
      `no source file mentions \`${OPTION}\` — if it was renamed, rename it here too`
    ).toBeGreaterThan(0);
  });

  it('lets exactly one flow ask for retraction', () => {
    const { setters } = scan();
    expect(
      setters,
      'Retraction destroys the shared stored object for every byte-identical image of every ' +
        'owner. Only a moderation takedown may request it. If you are adding a flow, say why ' +
        'here; if the moderation flow has stopped asking, that is a silent loss of the capability.'
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

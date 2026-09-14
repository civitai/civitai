import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_REASON_LENGTH } from '@civitai/moderation';

/**
 * Drift guard for the `reason` cap across every abuse-report PRODUCER.
 *
 * WHAT IT PINS: the RELATIONSHIP between the contract's `MAX_REASON_LENGTH` and the producers that
 * truncate to it. Each producer's own suite pins its own truncation, and that is exactly what none
 * of them can see: a producer restating the literal agrees with the contract only while the two
 * numbers happen to match. Lowering the contract's bound would leave that producer trimming to a
 * length the parser now rejects, and the first sign of it is that detector's runs vanishing from the
 * board rather than any test here going red.
 *
 * WHAT IT IS NOT — stated plainly, because the export it guards was described once as making the
 * caps "equal by construction" and that was true of one producer out of three:
 *
 *  - It does NOT make the two local copies correct. They are consistent with the contract today by
 *    coincidence of the number. Migrating them is deliberate work with its own suites to update, and
 *    was left out of the change that added this file.
 *  - It is a SOURCE-TEXT check over a directory listing, not a type or dependency check. It cannot
 *    see a cap reached indirectly — a bound read from a helper, a re-export, an object field, or a
 *    producer that lives somewhere other than `src/server/services/<name>/report.ts`.
 *  - It matches the IDENTIFIER, so the nearest-neighbour shape walks straight past it: a producer
 *    that writes `const REASON_CAP = 2_000` holds exactly the copy this file exists to catch and
 *    stays off the ledger, green. Pinning the literal instead would fire on every unrelated 2_000 in
 *    a producer, so the name is the tractable half — but it is the half a rename defeats.
 *  - A green run says the SET did not change. It says nothing about whether the values agree; the
 *    behavioural pinning of the imported bound lives in `report.test.ts` beside this file.
 *
 * So: a tripwire that forces a conscious decision on the common shape, in both directions.
 */

/** `src/server/services` — the parent of every producer directory. */
const SERVICES_DIR = path.resolve(__dirname, '../..');

/**
 * Every producer that still declares its OWN `MAX_REASON_LENGTH` instead of importing the contract's.
 *
 * Adding a name here is a deliberate act and so is removing one: the assertions below fail if
 * reality and this list diverge in EITHER direction. Growing means a new producer copied the
 * literal; shrinking means one was migrated and this ledger — plus the note on the exported constant
 * in `packages/civitai-moderation/src/schema.ts` — is now overclaiming and must be updated with it.
 */
const LOCAL_DECLARATION_LEDGER = ['bot-account-detection', 'reaction-withdrawal-detection'].sort();

/**
 * Producers known to exist at all. Separate from the ledger above and asserted separately, because
 * a discovery wired to nothing returns an empty set that satisfies an "equals the ledger" check only
 * when the ledger is empty — but returns an empty set that looks like PROGRESS once the ledger
 * shrinks to zero. Pinning the population makes a scan of no files loud instead of reassuring.
 */
const KNOWN_PRODUCERS = [
  'bot-account-detection',
  'new-order-abuse-detection',
  'reaction-withdrawal-detection',
].sort();

/**
 * A DECLARATION of the identifier, not a mention of it, and applied to RAW source.
 *
 * The `[ \t]*` between the line anchor and the keyword admits whitespace and nothing else, which is
 * what makes reading raw source safe for the ordinary comment shapes: `/` is not `[ \t]`, so neither
 * a commented-out `// const MAX_REASON_LENGTH = 2_000` nor a JSDoc ` * const MAX_REASON_LENGTH` can
 * satisfy it, and a trailing `foo(); // const MAX_REASON_LENGTH` fails the anchor outright. All
 * three of these files name the identifier in prose and none of those mentions match.
 *
 * It is NOT comment-aware, and that is deliberate. A previous version stripped comments first with
 * `/\/\*[\s\S]*?\*\//g`, which is blind to string literals: a producer whose `report.ts` contained
 * `/*` inside any string — a URL, a glob — opened a phantom comment that ran to the next block-
 * comment terminator and deleted the real declaration before this regex ever saw it, so the producer
 * passed green. That is
 * a SILENT PASS in the exact direction this file exists to prevent, bought for nothing, since the
 * anchor above already handles every motive the stripper cited.
 *
 * The residual risk runs the other way and is the safe one: an unprefixed `const MAX_REASON_LENGTH`
 * inside a block comment now matches, so the ledger GROWS and the assertion fails loudly. A guard
 * that over-reports gets looked at; one that under-reports does not.
 */
const LOCAL_DECLARATION =
  /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+MAX_REASON_LENGTH\b/;

/** Every `src/server/services/<name>/report.ts`, by directory name. */
function discoverProducers(): string[] {
  return fs
    .readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SERVICES_DIR, e.name, 'report.ts')))
    .map((e) => e.name)
    .sort();
}

const read = (name: string) => fs.readFileSync(path.join(SERVICES_DIR, name, 'report.ts'), 'utf8');

describe('MAX_REASON_LENGTH — producer drift ledger', () => {
  it('finds the producer files it claims to scan', () => {
    // 🔴 The positive control. Without it every assertion below is satisfiable by scanning zero
    // files, and a guard that scans zero files passes forever — the shape this whole file exists to
    // catch in the code it guards.
    const found = discoverProducers();
    expect(found).toEqual(expect.arrayContaining(KNOWN_PRODUCERS));
    expect(found.length).toBeGreaterThanOrEqual(KNOWN_PRODUCERS.length);
    // And it read real bytes, not empty strings a regex would never match.
    for (const name of KNOWN_PRODUCERS) expect(read(name).length).toBeGreaterThan(100);
  });

  it('detects a local declaration where one exists — the regex is not wired to nothing', () => {
    // The other half of the control: `LOCAL_DECLARATION` must actually match the known copies. A
    // regex that matched nothing would report a clean ledger of zero, which reads as the migration
    // being complete.
    for (const name of LOCAL_DECLARATION_LEDGER) {
      expect(LOCAL_DECLARATION.test(read(name))).toBe(true);
    }
  });

  it('🔴 no producer outside the ledger declares its own MAX_REASON_LENGTH', () => {
    const withLocalCopy = discoverProducers().filter((name) => LOCAL_DECLARATION.test(read(name)));

    expect(
      withLocalCopy,
      `Producers declaring a local MAX_REASON_LENGTH changed.\n` +
        `  expected (ledger): ${LOCAL_DECLARATION_LEDGER.join(', ') || '(none)'}\n` +
        `  found:             ${withLocalCopy.join(', ') || '(none)'}\n` +
        `A file that appeared here copied the contract's literal instead of importing ` +
        `MAX_REASON_LENGTH from '@civitai/moderation' — the copy drifts silently and the first ` +
        `sign is that detector's runs vanishing from the board. A file that DISAPPEARED was ` +
        `migrated: update this ledger and the note on the exported constant in ` +
        `packages/civitai-moderation/src/schema.ts, which names these two by hand.`
    ).toEqual(LOCAL_DECLARATION_LEDGER);
  });

  it('the migrated producer really imports the contract bound', () => {
    // Pins the relationship the ledger's absence-of-a-declaration cannot: `new-order-abuse-detection`
    // is off the ledger because it IMPORTS the constant, not because it stopped bounding the reason.
    // Requires a real module edge carrying the specifier, so deleting the import while leaving the
    // identifier in a comment does not pass.
    const source = read('new-order-abuse-detection');
    expect(source).toMatch(
      /(?:^|\n)\s*import\s*\{[^}]*\bMAX_REASON_LENGTH\b[^}]*\}\s*from\s*['"]@civitai\/moderation['"]/
    );
    // And the module it imports really exports a usable number, so this file cannot vouch for an
    // edge onto a binding that no longer exists.
    expect(typeof MAX_REASON_LENGTH).toBe('number');
    expect(MAX_REASON_LENGTH).toBeGreaterThan(0);
  });
});

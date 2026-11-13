import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE D4 RULING, GUARDED — OPERATOR DECISION OF 2026-10-01: D4 BINDS PRE-APPROVAL ONLY.
 *
 * ── THE RULING ──────────────────────────────────────────────────────────────────
 * A listing may carry `visibility: 'moderators'` at any eligible status. On a
 * `draft`/`pending` listing a moderator's review run falls through to
 * `resolvePrivateRunAccess`, mints the verified `privateRun` claim, and every
 * owner-invisibility rail fires. On an `approved` listing it cannot — the public path owns
 * that status unconditionally — so a moderator reviewing an approved listing at
 * `moderators` level IS debited Buzz and the publisher IS credited the author fee, and the
 * run appears in that owner's analytics.
 *
 * That was ACCEPTED, on the grounds that an approved app is already publicly runnable by
 * anyone holding its slug (so the run is indistinguishable from real usage), and that the
 * alternative put a blocking listing read on the generation hot path. Narrowing D2 —
 * refusing `moderators` on an approved listing — was considered and rejected.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────
 * 🔴 THE CODE ALREADY BEHAVES THIS WAY BY DEFAULT, WHICH IS EXACTLY THE PROBLEM. A ruling
 * whose only evidence is that nothing was written is indistinguishable from an oversight,
 * and the obvious "fix" for a reader who finds it is to complete the exclusion — teaching
 * one of the rails about `app_listings.visibility`. That would reverse a product decision
 * while looking like a bug fix, and no existing guard would notice: the rails' own ledgers
 * assert that each one carries the private-run marker, never that it carries NOTHING ELSE.
 *
 * So the property pinned here is the rails' AUDIENCE-BLINDNESS: they key on the one
 * verified claim and know nothing about listing visibility. If a visibility symbol appears
 * in any of them, this fails and names the ruling.
 *
 * ⚠️ WHAT THIS IS NOT. It is not a claim that the ruling is correct, and it is not a
 * behavioural test of the fee path — it cannot be, because the state it describes is the
 * ABSENCE of a code path. It is a tripwire on a decision. Revisiting the ruling means
 * editing this file deliberately, which is the whole point.
 *
 * ⚠️ AND IT IS A SYMBOL SCAN, SO IT HAS THE LIMITS OF ONE. A rail that learned about the
 * level through a differently-named helper, or through a value threaded in from a caller,
 * would walk past it. The mitigation is that the level has exactly one reader module and
 * one shared value module, and both are named below — a third route would be a new module,
 * which is a reviewable event rather than a silent edit.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The owner-invisibility rails, by file, with what each one withholds.
 *
 * 🔴 IF YOU ARE HERE BECAUSE ONE OF THESE NOW MENTIONS VISIBILITY: that is not an
 * off-by-one in this list. It means the exclusion has been extended across the approval
 * boundary, which reverses the 2026-10-01 ruling. Take that decision explicitly — and if it
 * is taken, this file is what should change first.
 */
const EXCLUSION_RAILS = [
  {
    file: 'src/server/services/blocks/app-analytics.service.ts',
    withholds: 'the owner-visible engagement + spend aggregates',
  },
  {
    file: 'src/server/services/blocks/scope-activity-predicate.ts',
    withholds: 'the ONE definition of the owner-visible invocation filter',
  },
  {
    file: 'src/server/services/blocks/private-run-impression.service.ts',
    withholds: 'the `blockRenders` impression write',
  },
  {
    file: 'src/server/services/blocks/author-fee-charge.service.ts',
    withholds: 'the author-fee payee resolve — the money rail',
  },
] as const;

/**
 * Every spelling by which a rail could learn about the per-listing level.
 *
 * ⚠️ CODE SYMBOLS AND THE MODULE PATH — DELIBERATELY *NOT* THE BARE COLUMN NAME, and an
 * earlier version of this comment claimed the opposite. `visibility` as a bare word already
 * appears in one rail's PROSE (`scope-activity-predicate.ts` writes "owner-visibility
 * problem"), so including it would make this guard permanently red on correct code — and a
 * permanently-red guard is worse than none, because it trains people to delete it.
 *
 * What covers the raw-SQL route instead is structural rather than lexical: the column has
 * exactly TWO reader modules, both named in {@link VISIBILITY_MODULES}, and any rail reading
 * it would have to import one of them or add a third — which is a reviewable event, not a
 * silent edit. Stated as the real coverage rather than an aspiration.
 */
const VISIBILITY_SYMBOLS = [
  'app-listing-visibility',
  'AppListingVisibility',
  'listingVisibleInStore',
  'maxVisibilityForStatus',
  'parseStoredVisibility',
  'readListingVisibility',
  'visibilitiesVisibleToForStatus',
  'APP_LISTING_VISIBILITIES',
] as const;

/** Where the level legitimately lives, so the scan can be shown to work at all. */
const VISIBILITY_MODULES = [
  'src/shared/utils/app-listing-visibility.ts',
  'src/server/services/blocks/app-listing-visibility.service.ts',
] as const;

const RULING_SITE = 'src/server/services/blocks/private-run-access.service.ts';

describe('D4 binds pre-approval only — the ruling is attributed in the code', () => {
  it('[INV] the ruling, its date, its consequence and its rejected alternative are stated at the refusal site', () => {
    // 🔴 THE RULING MUST BE FINDABLE WHERE THE EXCLUSION DOES NOT FIRE, not only in a PR
    // body. A PR body is not in the tree a maintainer reads, and this arc has already had a
    // correction land where the author was looking rather than where a reader arrives from.
    const src = read(RULING_SITE);
    // Positive control: the file loaded and is the predicate, not an empty or wrong read.
    expect(src.length, `${RULING_SITE} must load`).toBeGreaterThan(5_000);
    expect(src).toContain('resolvePrivateRunPageBlock');

    // The ruling is ATTRIBUTED and DATED, so it cannot read as an accident.
    expect(src, 'the ruling must be dated and named as an operator decision').toContain(
      'OPERATOR RULING, 2026-10-01'
    );
    expect(src).toContain('D4 BINDS PRE-APPROVAL ONLY');
    // The CONSEQUENCE must be stated in plain terms — a ruling whose cost is not written
    // down is one the next reader will "fix".
    expect(src, 'the consequence must name who is debited and who is credited').toContain(
      'DEBITED BUZZ'
    );
    expect(src).toContain('AUTHOR FEE');
    // And the rejected alternative, so the decision space is visible rather than re-derived.
    expect(src.replace(/\s+/g, ' ')).toContain('REJECTED');
  });

  it('[INV] it is marked as a DECISION rather than a TODO', () => {
    // The failure mode this prevents is a reader treating the gap as unfinished work. A
    // `TODO`/`FIXME` beside it would invite exactly that.
    const src = read(RULING_SITE);
    const at = src.indexOf('OPERATOR RULING, 2026-10-01');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 2_500);
    const DISCLAIMER = 'NOT AN OVERSIGHT AND NOT A TODO';
    expect(block, 'the ruling block must say it is not an oversight').toContain(DISCLAIMER);
    // 🔴 THE DISCLAIMER IS STRIPPED BEFORE THE MARKER SCAN, and getting that wrong was a
    // real instrument bug caught on the first run: the required phrase CONTAINS the word
    // `TODO`, so the guard failed on the very text it demands. A check that cannot pass
    // against correct code is worse than no check — it gets deleted, and the hole it was
    // guarding comes back with it.
    const scanned = block.split(DISCLAIMER).join('');
    for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK']) {
      expect(scanned, `the ruling block must not read as deferred work (${marker})`).not.toContain(
        marker
      );
    }
    // Negative control: the scan still SEES a marker that is not the disclaimer, so the
    // stripping above did not neuter it.
    expect(`${block} TODO: wire this up`.split(DISCLAIMER).join('')).toContain('TODO');
  });
});

describe('the exclusion rails stay AUDIENCE-BLIND', () => {
  it('[INV][POSITIVE CONTROL] the scan can find these symbols where they really live', () => {
    // 🔴 WITHOUT THIS, A TYPO IN EVERY SYMBOL WOULD MAKE THE WHOLE FILE PASS VACUOUSLY. A
    // reassuring zero is indistinguishable from a scan wired to nothing, so prove each
    // needle is findable in the modules that legitimately own it before reading any zero.
    const owned = VISIBILITY_MODULES.map(read).join('\n');
    expect(owned.length).toBeGreaterThan(1_000);
    for (const sym of VISIBILITY_SYMBOLS) {
      expect(
        owned,
        `the scan's needle \`${sym}\` must exist somewhere, or it tests nothing`
      ).toContain(sym);
    }
  });

  it('[INV][NEGATIVE CONTROL] the scan detects a planted symbol', () => {
    // "I wrote a scan" and "the scan works" are different claims. Built from a literal so
    // it is a property of the matcher at any ref.
    const planted = 'const level = maxVisibilityForStatus(listing.status);';
    expect(VISIBILITY_SYMBOLS.some((sym) => planted.includes(sym))).toBe(true);
    const clean = 'const payee = resolveBlockAuthorFeePayee({ privateRun });';
    expect(VISIBILITY_SYMBOLS.some((sym) => clean.includes(sym))).toBe(false);
  });

  it.each(EXCLUSION_RAILS)(
    '[INV] $file knows nothing about the listing level — it withholds $withholds',
    ({ file, withholds }) => {
      const src = read(file);
      // Positive control per rail: the file loaded and is substantial, so a clean result is
      // a measurement rather than an empty string.
      expect(src.length, `${file} must load`).toBeGreaterThan(1_000);

      const found = VISIBILITY_SYMBOLS.filter((sym) => src.includes(sym));
      expect(
        found,
        `${file} (${withholds}) now references the per-listing visibility level: ` +
          `${found.join(', ')}. That EXTENDS the owner-invisibility exclusion across the ` +
          'approval boundary, which REVERSES the operator ruling of 2026-10-01 (D4 binds ' +
          `pre-approval only) rather than fixing a bug. See gate (3) of ${RULING_SITE}. ` +
          'If the ruling is being revisited, change this guard deliberately and say so.'
      ).toEqual([]);
    }
  );

  it('[INV] the rails still carry the private-run marker they DO key on', () => {
    // 🔴 THE OTHER DIRECTION, so this file cannot be satisfied by a rail that stopped
    // excluding ANYTHING. "Audience-blind" must mean "keys on the claim alone", not "keys on
    // nothing" — a rail emptied of its private-run arm would pass the scan above while the
    // pre-approval half of D4 silently stopped working.
    expect(read('src/server/services/blocks/scope-activity-predicate.ts')).toContain(
      'OWNER_VISIBLE_INVOCATION_FILTER'
    );
    expect(read('src/server/services/blocks/app-analytics.service.ts')).toContain(
      'OWNER_VISIBLE_INVOCATION_FILTER'
    );
    expect(read('src/server/services/blocks/private-run-impression.service.ts')).toContain(
      'resolvePrivateRunAccess'
    );
    expect(read('src/server/services/blocks/author-fee-charge.service.ts')).toContain('privateRun');
  });
});

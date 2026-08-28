import { describe, expect, it } from 'vitest';
import {
  FIRST_PASS_STRIKE_PREFIX,
  firstPassStrikeId,
  IMPORT_MARKER_PREFIXES,
  importedLegacyStrikeId,
  LEGACY_STRIKE_MARKER,
  legacyStrikeId,
  legacyStrikeIssuerName,
  legacyStrikeNotes,
} from '$lib/legacy-strike-import';

/**
 * This protocol is what lets the import run at any time without a second deploy behind it: the writer
 * stamps a legacy id into `internalNotes` and the two legacy readers subtract what it stamped. If the
 * two sides ever disagree, nothing errors — an account's enforcement history is simply listed twice, on
 * the screen where the next strike is decided.
 */
describe('legacy strike import marker', () => {
  it('round-trips what the migration writes', () => {
    expect(legacyStrikeId(legacyStrikeNotes(4211, 'some-moderator'))).toBe(4211);
  });

  it('reads an id whatever the moderator name looks like', () => {
    // `createdBy` is free text: Retool display names with spaces historically, usernames since the port.
    // A name containing the separator must not eat the id.
    expect(legacyStrikeId(legacyStrikeNotes(7, 'First Last'))).toBe(7);
    expect(legacyStrikeId(legacyStrikeNotes(7, ''))).toBe(7);
  });

  it('ignores notes that are not import markers', () => {
    // A moderator's own internal note must never be mistaken for a legacy id — that would hide a real
    // strike from the legacy list by "already imported".
    expect(legacyStrikeId(null)).toBeNull();
    expect(legacyStrikeId('')).toBeNull();
    expect(legacyStrikeId('Escalated after appeal')).toBeNull();
    expect(legacyStrikeId(`prefixed ${LEGACY_STRIKE_MARKER}12`)).toBeNull();
  });

  it('rejects a marker with no usable id rather than returning NaN', () => {
    // `new Set([NaN])` swallows every malformed row into one bucket, so a single bad note would mark
    // one arbitrary legacy strike as imported.
    expect(legacyStrikeId(`${LEGACY_STRIKE_MARKER}abc by x`)).toBeNull();
    expect(legacyStrikeId(LEGACY_STRIKE_MARKER)).toBeNull();
  });

  it('writes a marker the LIKE predicate the readers use will match', () => {
    // Both readers filter `internalNotes LIKE '<marker>%'` in SQL before parsing. A marker that did not
    // sit at the head would parse fine here and select nothing there.
    expect(legacyStrikeNotes(1, 'x').startsWith(LEGACY_STRIKE_MARKER)).toBe(true);
  });
});

/**
 * The FIRST import pass. Its rows landed Active with a point each, so failing to recognise one re-imports
 * a years-old strike back onto the escalation ladder.
 */
describe('first-pass import marker', () => {
  it('reads the id out of what the first pass wrote', () => {
    expect(firstPassStrikeId('Imported from Retool strike #123. Issued by: Sebastian')).toBe(123);
    expect(firstPassStrikeId('Imported from Retool strike #3979. Issued by: ')).toBe(3979);
  });

  it('does not confuse the two markers', () => {
    expect(firstPassStrikeId(legacyStrikeNotes(9, 'x'))).toBeNull();
    expect(legacyStrikeId('Imported from Retool strike #9. Issued by: x')).toBeNull();
  });

  it('ignores notes that are not first-pass markers', () => {
    expect(firstPassStrikeId(null)).toBeNull();
    expect(firstPassStrikeId('')).toBeNull();
    expect(firstPassStrikeId('Escalated after appeal')).toBeNull();
    expect(firstPassStrikeId(`prefixed ${FIRST_PASS_STRIKE_PREFIX}12`)).toBeNull();
    // `Number('')` is 0, not NaN — so `id > 0`, not `Number.isInteger`, is the guard doing the work.
    // Without it every malformed row collapses into one bucket and marks an arbitrary strike imported.
    expect(firstPassStrikeId(`${FIRST_PASS_STRIKE_PREFIX}abc`)).toBeNull();
    expect(firstPassStrikeId(FIRST_PASS_STRIKE_PREFIX)).toBeNull();
  });

  it('still reads the id when a moderator has appended to the note', () => {
    // The rows this cleanup KEEPS are the odd ones, and an appended note is the likeliest shape.
    expect(firstPassStrikeId('Imported from Retool strike #55. Issued by: X\nAppealed 2024')).toBe(
      55
    );
  });

  it('sits at the head, so the LIKE predicate the readers use will match', () => {
    // `alreadyImported` and the cleanup script both filter `LIKE '<prefix>%'` in SQL before parsing.
    expect(
      'Imported from Retool strike #1. Issued by: x'.startsWith(FIRST_PASS_STRIKE_PREFIX)
    ).toBe(true);
  });
});

/**
 * The union is the question every caller asks, and the one place it can be got wrong for all of them
 * at once.
 */
describe('importedLegacyStrikeId', () => {
  it('answers for either pass', () => {
    expect(importedLegacyStrikeId(legacyStrikeNotes(4211, 'mod'))).toBe(4211);
    expect(importedLegacyStrikeId('Imported from Retool strike #123. Issued by: Sebastian')).toBe(
      123
    );
  });

  it('returns null for a note that is not an import marker', () => {
    // The negative control: a moderator's own note must never read as "already imported", which would
    // hide a real strike from the import.
    expect(importedLegacyStrikeId('Escalated after appeal')).toBeNull();
    expect(importedLegacyStrikeId(null)).toBeNull();
  });

  it('covers every prefix the SQL filters on', () => {
    // The predicate is built from IMPORT_MARKER_PREFIXES; if a prefix were added there without teaching
    // the parser, rows would be selected and then silently dropped as unparseable.
    for (const prefix of IMPORT_MARKER_PREFIXES) {
      expect(importedLegacyStrikeId(`${prefix}77 by mod`)).toBe(77);
    }
  });
});

/**
 * For most imported strikes this name is the ONLY attribution that exists — 8,901 of 12,902 rows have
 * no `issuedBy` (production, 2026-08-27), because the import resolves an account only on an exact
 * username match. Losing the parse puts the strike list back to crediting nobody.
 */
describe('legacy strike issuer name', () => {
  it('round-trips what the migration writes', () => {
    expect(legacyStrikeIssuerName(legacyStrikeNotes(2449, 'Cameron'))).toBe('Cameron');
  });

  it('keeps a name that contains the separator', () => {
    // Retool display names are free text, and a truncated name credits a moderator who does not exist.
    expect(legacyStrikeIssuerName(legacyStrikeNotes(7, 'stood by me'))).toBe('stood by me');
  });

  it('credits nobody rather than guessing', () => {
    expect(legacyStrikeIssuerName(null)).toBeNull();
    expect(legacyStrikeIssuerName('Escalated after appeal')).toBeNull();
    // The marker check is the ONLY thing standing between a moderator's free text and the strike list.
    // A note that happens to contain the separator must not be read as attribution — and must not put
    // internal note text on the client, which the service promises it never does.
    expect(legacyStrikeIssuerName('Removed 3 images by hand')).toBeNull();
    expect(legacyStrikeIssuerName(legacyStrikeNotes(7, ''))).toBeNull();
    // The first-pass marker carries a name in a shape no production row has, so it is not parsed.
    expect(
      legacyStrikeIssuerName(`${FIRST_PASS_STRIKE_PREFIX}123. Issued by: Sebastian`)
    ).toBeNull();
  });
});

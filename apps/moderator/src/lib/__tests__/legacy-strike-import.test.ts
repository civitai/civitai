import { describe, expect, it } from 'vitest';
import { LEGACY_STRIKE_MARKER, legacyStrikeId, legacyStrikeNotes } from '$lib/legacy-strike-import';

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

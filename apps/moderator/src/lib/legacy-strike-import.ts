/**
 * The provenance protocol for legacy strikes copied into the main app's `UserStrike`.
 *
 * `UserStrike` has no column for "where did this row come from", so the import writes a marker at the
 * head of `internalNotes` — `includeInternalNotes` defaults false in `strike.service.ts`, so the field
 * is selected only for mod-facing reads.
 *
 * Defined once and imported by both sides — `migrate-legacy-strikes.ts` writes it,
 * `moderation-memory.service.ts` reads it to stop showing an imported strike twice. A copy in each
 * would let them drift silently, and the symptom of drift is duplicated enforcement history on the
 * screen where the next strike is decided.
 */
export const LEGACY_STRIKE_MARKER = 'retool:UserStrikes:';

/** `retool:UserStrikes:<id> by <name>` → `<id>`, or `null` for a note that is not an import marker. */
export function legacyStrikeId(internalNotes: string | null): number | null {
  if (!internalNotes?.startsWith(LEGACY_STRIKE_MARKER)) return null;
  const raw = internalNotes.slice(LEGACY_STRIKE_MARKER.length).split(' ')[0];
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** What the import writes. The name is the legacy `createdBy`, which is a display name, not an id. */
export const legacyStrikeNotes = (id: number, createdBy: string) =>
  `${LEGACY_STRIKE_MARKER}${id} by ${createdBy}`;

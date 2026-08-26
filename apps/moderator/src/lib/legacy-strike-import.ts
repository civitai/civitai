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

/**
 * The marker an EARLIER import pass wrote, before this protocol existed. Its rows landed Active with a
 * point each, so they count on the escalation ladder. Any code deciding "has this legacy strike already
 * been copied?" must consult BOTH markers — consulting only the one above re-imported 12,381 rows once.
 */
export const FIRST_PASS_STRIKE_PREFIX = 'Imported from Retool strike #';

/** `Imported from Retool strike #<id>. Issued by: …` → `<id>`, or `null`. */
export function firstPassStrikeId(internalNotes: string | null): number | null {
  if (!internalNotes?.startsWith(FIRST_PASS_STRIKE_PREFIX)) return null;
  const id = Number(internalNotes.slice(FIRST_PASS_STRIKE_PREFIX.length).split(/[^0-9]/)[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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

/**
 * Every marker a copied strike can wear. Callers that filter `internalNotes LIKE '<prefix>%'` must build
 * the predicate from this rather than naming one, so the SQL and `importedLegacyStrikeId` cannot diverge.
 */
export const IMPORT_MARKER_PREFIXES = [LEGACY_STRIKE_MARKER, FIRST_PASS_STRIKE_PREFIX] as const;

/**
 * The legacy id a row was copied from, whichever pass wrote it. Use this, never one parser — three
 * callers ask this question.
 */
export const importedLegacyStrikeId = (internalNotes: string | null): number | null =>
  legacyStrikeId(internalNotes) ?? firstPassStrikeId(internalNotes);

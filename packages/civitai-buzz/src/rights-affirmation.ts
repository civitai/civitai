import { paidGenerationGrant, type ModelVersionTerms } from './paid-access';

/**
 * The affirmation a creator must accept before a model version can be monetized (paid access or a
 * licensing fee). Bump the version whenever the wording changes — the statement is stored verbatim on
 * the version, so old records keep the text that was actually agreed to and the version says which
 * wording it was.
 */
export const MONETIZATION_RIGHTS_AFFIRMATION_VERSION = 1;
export const MONETIZATION_RIGHTS_AFFIRMATION_STATEMENT =
  'I hold the rights to monetize this model, including its training data and everything used to create it, and I accept responsibility for any claim arising from it being sold on Civitai.';

export type RightsAffirmation = {
  userId: number;
  affirmedAt: string;
  version: number;
  statement: string;
};

export function buildRightsAffirmation(userId: number): RightsAffirmation {
  return {
    userId,
    affirmedAt: new Date().toISOString(),
    version: MONETIZATION_RIGHTS_AFFIRMATION_VERSION,
    statement: MONETIZATION_RIGHTS_AFFIRMATION_STATEMENT,
  };
}

/**
 * Every field is validated, not just probed: this record is the whole evidentiary value of the
 * feature, and a half-formed one that still satisfies the gate would let a version monetize with no
 * usable record of who agreed to what. Reads fail open (treated as absent → asked again).
 */
export function readRightsAffirmation(meta: unknown): RightsAffirmation | null {
  const value = (meta as { rightsAffirmation?: unknown } | null)?.rightsAffirmation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<RightsAffirmation>;
  const valid =
    typeof record.userId === 'number' &&
    typeof record.version === 'number' &&
    typeof record.statement === 'string' &&
    record.statement.length > 0 &&
    typeof record.affirmedAt === 'string' &&
    !Number.isNaN(Date.parse(record.affirmedAt));
  return valid ? (record as RightsAffirmation) : null;
}

/**
 * Whether a version already carries a usable affirmation of the CURRENT wording. An older version
 * means the statement has since changed, so the creator is asked again rather than being held to text
 * they never saw. Pass `ownerId` to also require that the person who affirmed still owns the model —
 * an affirmation is a named person accepting liability, so it doesn't transfer with the model.
 */
export function hasCurrentRightsAffirmation(meta: unknown, ownerId?: number): boolean {
  const affirmation = readRightsAffirmation(meta);
  if (affirmation?.version !== MONETIZATION_RIGHTS_AFFIRMATION_VERSION) return false;
  return ownerId == null || affirmation.userId === ownerId;
}

/**
 * Whether a paid-access input actually charges for something, and so needs an affirmation. Mirrors
 * `assertPaidAccessInput`: an ungated config (no permanent flag, no timeframe) sells nothing, and a
 * `{ free: true }` generation grant isn't a charge.
 */
export function paidAccessCharges(
  input:
    | { permanent?: boolean; timeframeDays?: number; terms?: ModelVersionTerms | null }
    | null
    | undefined
): boolean {
  if (!input) return false;
  if (!input.permanent && (input.timeframeDays ?? 0) <= 0) return false;
  const terms = input.terms ?? {};
  return !!terms.download || !!paidGenerationGrant(terms);
}

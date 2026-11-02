import { ViolationType } from '~/server/common/enums';

const FULL = 1;
const HALF = 0.5;

// Typed on the enum so a new violation type forces a choice here.
const VIOLATION_WEIGHTS: Record<ViolationType, number> = {
  [ViolationType.RealPerson]: FULL,
  [ViolationType.RealPersonNsfw]: FULL,
  [ViolationType.RealisticMinor]: FULL,
  [ViolationType.RealisticMinorNsfw]: FULL,
  [ViolationType.AnimatedMinorNsfw]: FULL,
  [ViolationType.SchoolNsfw]: FULL,
  [ViolationType.MinorViolence]: FULL,
  [ViolationType.Bestiality]: FULL,
  [ViolationType.SexualViolence]: FULL,
  [ViolationType.Incest]: FULL,
  [ViolationType.Gore]: FULL,
  [ViolationType.Hate]: FULL,
  [ViolationType.FecalMatter]: HALF,
  [ViolationType.Diaper]: HALF,
  [ViolationType.BodilyFluids]: HALF,
  [ViolationType.Anorexia]: HALF,
  [ViolationType.NonAi]: HALF,
  [ViolationType.MindAlteredNsfw]: HALF,
  [ViolationType.Spam]: HALF,
  [ViolationType.Other]: 0,
};

const isViolationType = (reason: string): reason is ViolationType =>
  Object.prototype.hasOwnProperty.call(VIOLATION_WEIGHTS, reason);

/**
 * The share of the `reportsAgainst` penalty one removal costs, by its reason (the removal's
 * `violationType`, else its legacy `tosReason`). A reason that is empty or not a violation type
 * (legacy keys, free text) costs the full penalty, as every removal did before reasons were weighed.
 */
export function removalWeight(reason: string | null | undefined) {
  const key = reason?.trim();
  return key && isViolationType(key) ? VIOLATION_WEIGHTS[key] : FULL;
}

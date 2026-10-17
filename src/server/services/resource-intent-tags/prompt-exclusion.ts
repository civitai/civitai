import { auditPrompt, includesMinor, includesPoi } from '~/utils/metadata/audit';

/**
 * True when the platform's own prompt auditor rejects the text: the generator's gate (`auditPrompt`),
 * the minor check or the POI check. Fails closed: a throw excludes.
 */
export function promptExcludedByAuditor(text: string): boolean {
  try {
    const r = auditPrompt(text);
    return !r.success || r.blockedFor.length > 0 || !!includesMinor(text) || !!includesPoi(text);
  } catch {
    return true;
  }
}

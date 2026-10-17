import { auditPrompt, includesMinor } from '~/utils/metadata/audit';

/**
 * True when the platform's regex prompt audit (`auditPrompt`, which includes the POI check) or the
 * minor check rejects the text. Fails closed: a throw excludes.
 */
export function promptExcludedByAuditor(text: string): boolean {
  try {
    const r = auditPrompt(text);
    return !r.success || r.blockedFor.length > 0 || !!includesMinor(text);
  } catch {
    return true;
  }
}

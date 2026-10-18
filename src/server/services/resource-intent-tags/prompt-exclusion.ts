import { auditPrompt, includesMinor } from '~/utils/metadata/audit';

/**
 * True when the platform's regex prompt audit (`auditPrompt`, which includes the POI check) or the
 * minor check rejects the text. Fails closed: a throw excludes. The text is a user's private
 * generator prompt, so a slow audit logs its timings and shape only, never the text
 * (`privateInput`), whatever the slow-log env vars say.
 */
export function promptExcludedByAuditor(text: string): boolean {
  try {
    const r = auditPrompt(text, undefined, undefined, { privateInput: true });
    return !r.success || r.blockedFor.length > 0 || !!includesMinor(text);
  } catch {
    return true;
  }
}

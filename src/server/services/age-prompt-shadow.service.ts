import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import type { ExternalModerationSource } from '~/server/prom/external-moderation.metrics';
import { auditPromptEnriched } from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';

export const AGE_PROMPT_SHADOW_EVENT = 'age-prompt-shadow';

export type AgePromptSurface = 'remix-source' | 'post-scan';
type ClassifierStatus = 'ok' | 'failed' | 'skipped' | 'fell-back-to-regex';

const MAX_AGE_SPANS = 10;

/**
 * The prompt, normalized, with every age-check match cut out, so the rest of the regex audit can
 * still run on it. Undefined when a match cannot be located in the text.
 */
export function withoutMinorAge(prompt: string): string | undefined {
  let text = normalizeText(prompt);
  for (let i = 0; i < MAX_AGE_SPANS; i++) {
    // The age check runs first in the audit, so any age match is the first trigger.
    const [first] = auditPromptEnriched(text, undefined, false).triggers;
    if (first?.category !== 'minor_age') return text;
    const at = first.matchedText ? text.indexOf(first.matchedText) : -1;
    if (!first.matchedText || at < 0) return undefined;
    text = `${text.slice(0, at)} ${text.slice(at + first.matchedText.length)}`;
  }
  return undefined;
}

/**
 * Decides an age-check hit. Flag off: block, as before. Flag on: the external classifier decides,
 * and anything short of a clean verdict from it keeps the block. A clean verdict hands back the
 * prompt without the age match, for the caller's remaining regex checks.
 */
export async function decideAgeRegexHit({
  surface,
  age,
  prompt,
  source,
}: {
  surface: AgePromptSurface;
  age: number;
  prompt: string;
  source: ExternalModerationSource;
}): Promise<{ block: true } | { block: false; withoutAge: string }> {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SHADOW_AGE_PROMPT))) return { block: true };

  const withoutAge = withoutMinorAge(prompt);
  let status: ClassifierStatus;
  let verdict: 'flagged' | 'clean' | 'none' = 'none';
  if (withoutAge === undefined) status = 'fell-back-to-regex';
  // `moderatePrompt` answers not-flagged when unconfigured; that must not read as clean here.
  else if (!env.EXTERNAL_MODERATION_ENDPOINT || !env.EXTERNAL_MODERATION_TOKEN) status = 'skipped';
  else {
    try {
      const { flagged } = await extModeration.moderatePrompt(prompt, source);
      verdict = flagged ? 'flagged' : 'clean';
      status = 'ok';
    } catch {
      status = 'failed';
    }
  }

  const block = verdict !== 'clean';
  logToAxiom({
    name: AGE_PROMPT_SHADOW_EVENT,
    type: 'info',
    surface,
    ageBucket: age < 13 ? '<13' : '13-17',
    classifierVerdict: verdict,
    classifierStatus: status,
    blocked: block,
  }).catch(() => null);

  return block || withoutAge === undefined ? { block: true } : { block: false, withoutAge };
}

import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { extModeration } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import type { ExternalModerationSource } from '~/server/prom/external-moderation.metrics';
import { auditPromptEnriched } from '~/utils/metadata/audit';

export const AGE_PROMPT_SHADOW_EVENT = 'age-prompt-shadow';

export type AgePromptSurface = 'remix-source' | 'post-scan';
type ClassifierStatus = 'ok' | 'failed' | 'skipped' | 'fell-back-to-regex';

const MAX_AGE_SPANS = 10;

/** Where `span` occurs in `text` with no letter or digit on either side. */
function indexOfWhole(text: string, span: string) {
  const isWordChar = (c: string | undefined) => !!c && /[a-zA-Z0-9]/.test(c);
  for (let at = text.indexOf(span); at >= 0; at = text.indexOf(span, at + 1)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + span.length])) return at;
  }
  return -1;
}

/**
 * The prompt with every age-check match cut out, so the rest of the regex audit can still run on
 * it. Undefined when an age match cannot be isolated: it cannot be located, or the audit reports
 * another rule matching too, which may need the age text.
 */
export function withoutMinorAge(prompt: string): string | undefined {
  let text = prompt;
  for (let i = 0; i < MAX_AGE_SPANS; i++) {
    // The age check runs first in the audit, so any age match is the first trigger.
    const [first] = auditPromptEnriched(text, undefined, false).triggers;
    if (first?.category !== 'minor_age') return text;
    // The age rule is also reported under the minor rule, with the same regex.
    const otherRule = first.matches?.some(
      (m) => m.category !== 'minor_age' && m.matchedRegex !== first.matchedRegex
    );
    if (otherRule || !first.matchedText) return undefined;
    const at = indexOfWhole(text, first.matchedText);
    if (at < 0) return undefined;
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

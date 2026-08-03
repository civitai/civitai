import * as z from 'zod';
import { openrouter } from '~/server/services/ai/openrouter';
import type { TokenUsage } from '~/server/services/ai/openrouter';

const AI_REVIEW_VIOLATIONS = [
  'sexual/adult content',
  'no buzz reference',
  'graphic violence',
  'illegal drugs',
  'self-harm',
  'hate or extremism',
] as const;
export type AiReviewViolation = (typeof AI_REVIEW_VIOLATIONS)[number];

// The subset the model may report directly; the other two are decided from its booleans.
const MODEL_VIOLATIONS: AiReviewViolation[] = AI_REVIEW_VIOLATIONS.filter(
  (v) => v !== 'sexual/adult content' && v !== 'no buzz reference'
);

// Rendered after the notification's own "Your submission to X wasn't accepted." so these are
// clauses, not sentences. Fixed here rather than passed through from the model.
export const DEFAULT_AI_REVIEW_REASON_COPY: Record<string, string> = {
  'sexual/adult content': 'This collection needs to stay PG-13.',
  'no buzz reference':
    "It doesn't mention Buzz — add 'buzz pls' text or a Buzz lightning bolt and try again!",
  'graphic violence': 'It shows graphic violence or injury.',
  'illegal drugs': 'It depicts illegal substances.',
  'self-harm': 'It touches on self-harm themes.',
  'hate or extremism': 'It contains hateful or extremist content.',
};

const GENERIC_REJECTION = "It doesn't meet this collection's guidelines.";

// Anything at or above R means the image does not belong on an all-ages surface. 'R+' is what the
// prompt asks for; the rest are the labels a model reaches for on its own.
const ADULT_RATINGS = ['r+', 'r', 'x', 'xxx', 'nsfw', 'explicit'];

// The booleans the rules depend on are required: a response missing them is one we cannot read,
// and it must not resolve to approve.
export const aiReviewObservationsSchema = z.object({
  reason: z.string().optional(),
  sexualContent: z.boolean(),
  suggestiveStyling: z.boolean().optional(),
  nsfwEstimate: z.string().optional(),
  isPhotorealistic: z.boolean(),
  depictsMinor: z.boolean(),
  minorUncertain: z.boolean().optional(),
  minorIsPhotorealistic: z.boolean().optional(),
  minorInappropriate: z.boolean().optional(),
  depictsRealPerson: z.boolean(),
  otherViolations: z.array(z.string()).optional(),
  hasBuzzReference: z.boolean(),
});

export type AiReviewDecision = {
  decision: 'approve' | 'reject' | 'escalate';
  violations: AiReviewViolation[];
  escalations: string[];
  /**
   * The escalation is our uncertainty, not a finding against the submission — an unreadable
   * response, or a subject whose age the model could not determine. Callers must never turn this
   * into a rejection; nobody should be told they broke a rule because we could not tell.
   */
  neverReject?: boolean;
};

// Takes `unknown` because a refusal, a provider fallback, or schema drift all arrive as parseable
// JSON with the wrong shape.
export function decideFromObservations(raw: unknown): AiReviewDecision {
  const parsed = aiReviewObservationsSchema.safeParse(raw);
  if (!parsed.success)
    return {
      decision: 'escalate',
      violations: [],
      escalations: ['unreadable model response'],
      neverReject: true,
    };

  const o = parsed.data;
  const violations: AiReviewViolation[] = [];
  const escalations: string[] = [];

  // Also honoured when the model only suspects a minor: these are seven independent booleans with
  // no cross-validation, and a hedged depictsMinor alongside a positive finding is exactly the
  // inconsistency the rules layer exists to absorb.
  const anyMinorSignal = o.depictsMinor || !!o.minorUncertain;
  if (anyMinorSignal && o.minorIsPhotorealistic) escalations.push('photorealistic minor');
  if (anyMinorSignal && o.minorInappropriate) escalations.push('minor depicted inappropriately');
  if (o.depictsRealPerson) escalations.push('real person likeness');

  const adultRating = ADULT_RATINGS.includes((o.nsfwEstimate ?? '').toLowerCase().trim());
  if (o.sexualContent || adultRating) violations.push('sexual/adult content');
  else if (o.suggestiveStyling) escalations.push('suggestive styling');

  // Escalating on this hedge alone would sweep up much of the stylized art these collections are
  // made of, which is exactly what the prompt invites the model to be unsure about. It matters
  // where the presentation is sexualized, and — per rules/minors.md, where photorealism is the
  // bright line for minors in ANY context — where the image could pass for a photograph.
  const uncertainAge =
    !!o.minorUncertain && (!!o.suggestiveStyling || o.sexualContent || !!o.isPhotorealistic);
  if (uncertainAge) escalations.push('possible minor');

  for (const entry of o.otherViolations ?? []) {
    const value = entry.toLowerCase().trim();
    if (!value) continue;
    const known = MODEL_VIOLATIONS.find((v) => v === value);
    if (known) violations.push(known);
    else escalations.push(`unrecognized category: ${entry}`);
  }

  if (!o.hasBuzzReference) violations.push('no buzz reference');

  const decision = escalations.length ? 'escalate' : violations.length ? 'reject' : 'approve';
  return {
    decision,
    violations,
    escalations,
    neverReject: uncertainAge || undefined,
  };
}

/**
 * Escalation text can contain arbitrary model output, so it is never eligible for lookup — only
 * the closed violation set reaches a submitter.
 */
export function resolveRejectionMessage(
  violations: AiReviewViolation[],
  reasonCopy?: Record<string, string>
) {
  const [first] = violations;
  if (!first) return GENERIC_REJECTION;
  return reasonCopy?.[first] ?? DEFAULT_AI_REVIEW_REASON_COPY[first] ?? first;
}

export const isAiReviewAvailable = () => !!openrouter;

// The codebase treats both 0 and -1 as "not yet rated" (see updateCollectionItemsStatus's
// judgesApplyBrowsingLevel guard), so neither is a level and neither is allowed here.
export const isUnratedNsfwLevel = (nsfwLevel: number) => nsfwLevel <= 0;

export function isNsfwLevelAllowed(nsfwLevel: number, allowedNsfwLevels: number) {
  return !isUnratedNsfwLevel(nsfwLevel) && (nsfwLevel & allowedNsfwLevels) !== 0;
}

export async function reviewImage({
  imageUrl,
  prompt,
  model,
  systemPrompt,
}: {
  imageUrl: string;
  prompt?: string | null;
  model: string;
  systemPrompt: string;
}): Promise<{ observations: unknown; usage: TokenUsage } | null> {
  if (!openrouter) return null;

  const { content, usage } = await openrouter.getJsonCompletionWithUsage<unknown>({
    model,
    temperature: 0,
    maxTokens: 4000,
    retries: 2,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: `Generation prompt: ${prompt?.slice(0, 1500) || '(none)'}` },
        ],
      },
    ],
  });

  return { observations: content, usage };
}

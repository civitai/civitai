import { openrouter } from '~/server/services/ai/openrouter';
export { DEFAULT_AI_REVIEW_PROMPT } from '~/server/services/ai/collection-review.prompt';
import type { TokenUsage } from '~/server/services/ai/openrouter';

export const AI_REVIEW_VIOLATIONS = [
  'sexual/adult content',
  'no buzz reference',
  'graphic violence',
  'illegal drugs',
  'self-harm',
  'hate or extremism',
] as const;
export type AiReviewViolation = (typeof AI_REVIEW_VIOLATIONS)[number];

const MODEL_VIOLATIONS: string[] = [
  'graphic violence',
  'illegal drugs',
  'self-harm',
  'hate or extremism',
];

export const DEFAULT_AI_REVIEW_REASON_COPY: Record<string, string> = {
  'sexual/adult content': "Your entry wasn't accepted because this collection needs to stay PG-13.",
  'no buzz reference':
    "Your entry wasn't accepted because it doesn't mention Buzz. Add 'buzz pls' text or a Buzz lightning bolt and try again!",
  'graphic violence': "Your entry wasn't accepted because it shows graphic violence or injury.",
  'illegal drugs': "Your entry wasn't accepted because it depicts illegal substances.",
  'self-harm': "Your entry wasn't accepted because it touches on self-harm themes.",
  'hate or extremism':
    "Your entry wasn't accepted because it contains hateful or extremist content.",
};

const GENERIC_REJECTION =
  "Your entry wasn't accepted because it doesn't meet this collection's guidelines.";

export type AiReviewObservations = {
  reason?: string;
  sexualContent?: boolean;
  suggestiveStyling?: boolean;
  nsfwEstimate?: 'PG' | 'PG-13' | 'R+';
  depictsMinor?: boolean;
  minorUncertain?: boolean;
  minorIsPhotorealistic?: boolean;
  minorInappropriate?: boolean;
  depictsRealPerson?: boolean;
  otherViolations?: string[];
  hasBuzzReference?: boolean;
};

export type AiReviewDecision = {
  decision: 'approve' | 'reject' | 'escalate';
  violations: AiReviewViolation[];
  escalations: string[];
};

/**
 * The model reports observations; this turns them into a verdict. Keeping the rules here means
 * they can be retuned or audited without re-running any classification, and a model that hedges
 * cannot approve something the rules forbid.
 */
export function decideFromObservations(o: AiReviewObservations): AiReviewDecision {
  const violations: AiReviewViolation[] = [];
  const escalations: string[] = [];

  if (o.depictsMinor && o.minorIsPhotorealistic) escalations.push('photorealistic minor');
  if (o.depictsMinor && o.minorInappropriate) escalations.push('minor depicted inappropriately');
  if (o.depictsRealPerson) escalations.push('real person likeness');

  if (o.sexualContent || o.nsfwEstimate === 'R+') violations.push('sexual/adult content');
  else if (o.suggestiveStyling) escalations.push('suggestive styling');

  for (const raw of o.otherViolations ?? []) {
    const value = String(raw).toLowerCase().trim();
    if (MODEL_VIOLATIONS.includes(value)) violations.push(value as AiReviewViolation);
    else escalations.push(`unrecognized category: ${raw}`);
  }

  if (o.hasBuzzReference === false) violations.push('no buzz reference');

  const decision = escalations.length ? 'escalate' : violations.length ? 'reject' : 'approve';
  return { decision, violations, escalations };
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

export function isNsfwLevelAllowed(nsfwLevel: number, allowedNsfwLevels: number) {
  return nsfwLevel > 0 && (nsfwLevel & allowedNsfwLevels) !== 0;
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
}): Promise<{ observations: AiReviewObservations; usage: TokenUsage } | null> {
  if (!openrouter) return null;

  const { content, usage } = await openrouter.getJsonCompletionWithUsage<AiReviewObservations>({
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

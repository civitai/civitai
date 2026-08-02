import * as z from 'zod';
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

// Anything at or above R means the image does not belong on an all-ages surface. 'R+' is what the
// prompt asks for; the rest are the labels a model reaches for on its own.
const ADULT_RATINGS = ['r+', 'r', 'x', 'xxx', 'nsfw', 'explicit'];

/**
 * The booleans the rules depend on are REQUIRED. A response missing them is not a clean bill of
 * health — it is a response we cannot read, and it must not resolve to approve.
 */
export const aiReviewObservationsSchema = z.object({
  reason: z.string().optional(),
  sexualContent: z.boolean(),
  suggestiveStyling: z.boolean().optional(),
  nsfwEstimate: z.string().optional(),
  depictsMinor: z.boolean(),
  minorUncertain: z.boolean().optional(),
  minorIsPhotorealistic: z.boolean().optional(),
  minorInappropriate: z.boolean().optional(),
  depictsRealPerson: z.boolean(),
  otherViolations: z.array(z.string()).optional(),
  hasBuzzReference: z.boolean(),
});

export type AiReviewObservations = z.infer<typeof aiReviewObservationsSchema>;

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

/**
 * The model reports observations; this turns them into a verdict. Keeping the rules here means
 * they can be retuned or audited without re-running any classification, and a model that hedges
 * cannot approve something the rules forbid.
 *
 * Takes `unknown` on purpose: the input is unvalidated model output, and a refusal, a fallback to
 * a different provider, or plain schema drift all arrive as parseable JSON with the wrong shape.
 */
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

  if (o.depictsMinor && o.minorIsPhotorealistic) escalations.push('photorealistic minor');
  if (o.depictsMinor && o.minorInappropriate) escalations.push('minor depicted inappropriately');
  if (o.depictsRealPerson) escalations.push('real person likeness');

  const adultRating = ADULT_RATINGS.includes((o.nsfwEstimate ?? '').toLowerCase().trim());
  if (o.sexualContent || adultRating) violations.push('sexual/adult content');
  else if (o.suggestiveStyling) escalations.push('suggestive styling');

  // Section B of the prompt invites this hedge on the stylized art these collections are mostly
  // made of, so on its own it would escalate a large share of perfectly ordinary submissions. An
  // ambiguous age only matters where the presentation is also sexualized.
  const uncertainAgeInSexualContext = o.minorUncertain && (o.suggestiveStyling || o.sexualContent);
  if (uncertainAgeInSexualContext) escalations.push('possible minor in suggestive context');

  for (const entry of o.otherViolations ?? []) {
    const value = entry.toLowerCase().trim();
    if (!value) continue;
    if (MODEL_VIOLATIONS.includes(value)) violations.push(value as AiReviewViolation);
    else escalations.push(`unrecognized category: ${entry}`);
  }

  if (!o.hasBuzzReference) violations.push('no buzz reference');

  const decision = escalations.length ? 'escalate' : violations.length ? 'reject' : 'approve';
  return {
    decision,
    violations,
    escalations,
    neverReject: uncertainAgeInSexualContext || undefined,
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

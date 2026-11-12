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
const SAFE_RATINGS = ['g', 'pg', 'pg-13', 'pg13', 'sfw'];

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

const OBSERVATION_COLUMNS = [
  'minorUncertain',
  'depictsMinor',
  'isPhotorealistic',
  'suggestiveStyling',
  'sexualContent',
] as const;
export type AiReviewObservationColumns = Record<(typeof OBSERVATION_COLUMNS)[number], -1 | 0 | 1>;

/** For the audit row: 1 or 0 as the model answered, -1 where there is no readable answer. */
export function toObservationColumns(raw: unknown): AiReviewObservationColumns {
  const parsed = aiReviewObservationsSchema.safeParse(raw);
  const o = parsed.success ? parsed.data : undefined;
  const columns = {} as AiReviewObservationColumns;
  for (const key of OBSERVATION_COLUMNS) {
    const value = o?.[key];
    columns[key] = value === undefined ? -1 : value ? 1 : 0;
  }
  return columns;
}

export type AiReviewDecision = {
  decision: 'approve' | 'reject' | 'escalate';
  violations: AiReviewViolation[];
  escalations: string[];
  /** Callers must leave this escalation for a human and never turn it into a rejection. */
  neverReject?: boolean;
};

const MINOR_ESCALATIONS = {
  photorealistic: 'photorealistic minor',
  inappropriate: 'minor depicted inappropriately',
  possible: 'possible minor',
} as const;
const MINOR_ESCALATION_VALUES: string[] = Object.values(MINOR_ESCALATIONS);

// Escalates to the minor queue whatever the collection decides.
export const needsMinorReview = ({ escalations }: Pick<AiReviewDecision, 'escalations'>) =>
  escalations.some((e) => MINOR_ESCALATION_VALUES.includes(e));

// Takes `unknown` because a refusal, a provider fallback, or schema drift all arrive as parseable
// JSON with the wrong shape.
export function decideFromObservations(
  raw: unknown,
  { isVideo = false }: { isVideo?: boolean } = {}
): AiReviewDecision {
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

  const anyMinorSignal = o.depictsMinor || !!o.minorUncertain;
  if (anyMinorSignal && o.minorIsPhotorealistic) escalations.push(MINOR_ESCALATIONS.photorealistic);
  if (anyMinorSignal && o.minorInappropriate) escalations.push(MINOR_ESCALATIONS.inappropriate);
  if (o.depictsRealPerson) escalations.push('real person likeness');

  const rating = (o.nsfwEstimate ?? '').toLowerCase().trim();
  const adultRating = ADULT_RATINGS.includes(rating);
  const unrecognizedRating = !adultRating && !SAFE_RATINGS.includes(rating);
  if (o.sexualContent || adultRating) violations.push('sexual/adult content');
  else if (o.suggestiveStyling) escalations.push('suggestive styling');
  const ratingEscalation = unrecognizedRating
    ? `unrecognized nsfwEstimate: ${o.nsfwEstimate?.slice(0, 40) || '(none)'}`
    : undefined;
  if (ratingEscalation) escalations.push(ratingEscalation);

  const uncertainAge =
    !!o.minorUncertain && (!!o.suggestiveStyling || o.sexualContent || !!o.isPhotorealistic);
  if (uncertainAge) escalations.push(MINOR_ESCALATIONS.possible);

  for (const entry of o.otherViolations ?? []) {
    const value = entry.toLowerCase().trim();
    if (!value) continue;
    const known = MODEL_VIOLATIONS.find((v) => v === value);
    if (known) violations.push(known);
    else escalations.push(`unrecognized category: ${entry}`);
  }

  if (!o.hasBuzzReference) {
    // Only the first frame is sent, so a reference that appears later in a video — or is spoken —
    // is invisible to the model. Not enough to reject a submission on.
    if (isVideo) escalations.push('no buzz reference in first frame');
    else violations.push('no buzz reference');
  }

  const decision = escalations.length ? 'escalate' : violations.length ? 'reject' : 'approve';
  return {
    decision,
    violations,
    escalations,
    // An unreadable label is only our uncertainty while it is the response's sole finding; it must
    // not shield a real escalation from a collection that rejects escalations.
    neverReject:
      uncertainAge ||
      (!!ratingEscalation &&
        !violations.length &&
        escalations.every((e) => e === ratingEscalation)) ||
      (isVideo && !o.hasBuzzReference) ||
      undefined,
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

// 0 (not yet scanned or rated) and -1 are not levels, so neither is allowed here.
export const isUnratedNsfwLevel = (nsfwLevel: number) => nsfwLevel <= 0;

export function isNsfwLevelAllowed(nsfwLevel: number, allowedNsfwLevels: number) {
  return !isUnratedNsfwLevel(nsfwLevel) && (nsfwLevel & allowedNsfwLevels) !== 0;
}

// A vision call normally answers in seconds; past this the item takes the job's failed-attempt path.
export const REVIEW_TIMEOUT_MS = 60_000;

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
    timeoutMs: REVIEW_TIMEOUT_MS,
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

import * as z from 'zod';

export const aiToolkitOptionSchema = z.object({
  lrWarmupSteps: z.number().int().min(0).max(10000).optional(),
  captionDropoutRate: z.number().min(0).max(1).optional(),
  rankDropout: z.number().min(0).lt(1).optional(),
  trainConv: z.boolean().optional(),
});

export type AiToolkitOptions = z.infer<typeof aiToolkitOptionSchema>;
export const AI_TOOLKIT_OPTION_FIELDS = [
  'lrWarmupSteps',
  'captionDropoutRate',
  'rankDropout',
  'trainConv',
] as const;

type OptionContext = {
  engine?: string;
  ecosystem: string;
  lrScheduler?: string | null;
  steps?: number | null;
};

export function aiToolkitOptionSupport({ engine, ecosystem, lrScheduler, steps }: OptionContext) {
  const enabled = engine === 'ai-toolkit';
  return {
    lrWarmupSteps:
      enabled &&
      steps != null &&
      (lrScheduler === 'constant' || lrScheduler === 'constant_with_warmup'),
    captionDropoutRate: enabled && ecosystem !== 'yue2',
    rankDropout: enabled,
    trainConv: enabled && (ecosystem === 'sd1' || ecosystem === 'sdxl'),
  };
}

// Restored drafts can carry settings for a different model, engine or scheduler.
export function pickAiToolkitOptions(
  context: OptionContext,
  values: AiToolkitOptions
): AiToolkitOptions {
  const support = aiToolkitOptionSupport(context);
  return Object.fromEntries(
    AI_TOOLKIT_OPTION_FIELDS.filter((field) => support[field] && values[field] !== undefined).map(
      (field) => [field, values[field]]
    )
  );
}

export function parseAiToolkitOptions(
  context: OptionContext,
  values: AiToolkitOptions
): AiToolkitOptions {
  return aiToolkitOptionSchema
    .refine(
      (options) =>
        options.lrWarmupSteps === undefined || options.lrWarmupSteps <= (context.steps ?? 10000),
      { path: ['lrWarmupSteps'], message: 'Warmup steps cannot exceed total training steps.' }
    )
    .parse(pickAiToolkitOptions(context, values));
}

export function trainingIgnoredWarnings(
  steps:
    | readonly { warnings?: readonly { code?: string; message?: string | null }[] | null }[]
    | null
    | undefined
): string[] {
  return [
    ...new Set(
      steps?.flatMap(
        (step) =>
          step.warnings?.flatMap((warning) =>
            warning.code === 'fieldIgnored' && warning.message ? [warning.message] : []
          ) ?? []
      ) ?? []
    ),
  ];
}
